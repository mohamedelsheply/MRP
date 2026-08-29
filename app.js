    // ============ متغيرات عالمية ============
    let masterData = [];          // البيانات الأساسية الثابتة: {code, desc, minQty, maxQty}
    let pendingMasterRows = null; // بيانات شيت أساسية تم رفعه (تُدمج فورًا عند الرفع)
    let pendingStockRows = null;  // بيانات شيت تحديث الرصيد (تنتظر التأكيد)
    let generatedOrderItems = []; // آخر تقرير طلب شراء تم توليده
    let unmatchedStockItems = []; // أصناف موجودة في شيت الرصيد لكن مش موجودة بالبيانات الأساسية: {code, currentStock}
    let unmatchedItemsShown = []; // آخر قائمة معروضة فعليًا من الأصناف غير المطابقة (بعد أي فلترة بالكمية) - تُستخدم عند التصدير

    const MASTER_STORAGE_KEY = 'masterStockData';
    const ORDERS_STORAGE_KEY = 'savedPurchaseOrders';
    const AUDIT_LOG_STORAGE_KEY = 'auditMovementsLog';
    const AUDIT_ATTACHMENTS_STORAGE_KEY = 'auditAttachmentDocs';

    // ============ طبقة تخزين IndexedDB ============
    // بنستخدم IndexedDB بدل localStorage لأن مساحة localStorage محدودة جداً (5-10 ميجا بس)
    // وبتمتلئ بسرعة مع آلاف الأصناف وعدة طلبات محفوظة. IndexedDB مساحته أكبر بكتير (مئات الميجا وأكتر).
    const IDB_NAME = 'sparePartsSystemDB';
    const IDB_VERSION = 1;
    const IDB_STORE = 'appData';

    function idbOpen() {
        return new Promise((resolve, reject) => {
            if (!window.indexedDB) { reject(new Error('IndexedDB غير مدعوم في هذا المتصفح')); return; }
            let req = indexedDB.open(IDB_NAME, IDB_VERSION);
            req.onupgradeneeded = function (e) {
                let db = e.target.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) {
                    db.createObjectStore(IDB_STORE);
                }
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    async function idbGet(key) {
        let db = await idbOpen();
        return new Promise((resolve, reject) => {
            let tx = db.transaction(IDB_STORE, 'readonly');
            let req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    async function idbSet(key, value) {
        let db = await idbOpen();
        return new Promise((resolve, reject) => {
            let tx = db.transaction(IDB_STORE, 'readwrite');
            let req = tx.objectStore(IDB_STORE).put(value, key);
            req.onsuccess = function () { resolve(); };
            req.onerror = function () { reject(req.error); };
        });
    }

    // ترحيل تلقائي لمرة واحدة: لو المستخدم عنده بيانات قديمة محفوظة في localStorage من نسخة سابقة من النظام،
    // ننقلها لـ IndexedDB عشان ميضيعش أي بيانات قديمة بعد التحديث
    async function migrateFromLocalStorageIfNeeded() {
        try {
            let oldMaster = localStorage.getItem(MASTER_STORAGE_KEY);
            if (oldMaster) {
                let existing = await idbGet(MASTER_STORAGE_KEY);
                if (!existing) { await idbSet(MASTER_STORAGE_KEY, JSON.parse(oldMaster)); }
                localStorage.removeItem(MASTER_STORAGE_KEY);
            }
            let oldOrders = localStorage.getItem(ORDERS_STORAGE_KEY);
            if (oldOrders) {
                let existing = await idbGet(ORDERS_STORAGE_KEY);
                if (!existing) { await idbSet(ORDERS_STORAGE_KEY, JSON.parse(oldOrders)); }
                localStorage.removeItem(ORDERS_STORAGE_KEY);
            }
        } catch (err) {
            console.error('فشل ترحيل البيانات القديمة إلى IndexedDB:', err);
        }
    }

    // بيفحص فعليًا هل التخزين شغال ولا لأ، وبيرجع سبب دقيق لو مش شغال
    async function checkStorageHealth() {
        try {
            const testKey = '__storage_test__';
            await idbSet(testKey, '1');
            await idbGet(testKey);
            return { ok: true };
        } catch (err) {
            let reason = 'سبب غير معروف: ' + (err.name || '') + ' - ' + (err.message || '');
            if (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
                reason = 'مساحة التخزين في الجهاز امتلأت فعلاً. خد نسخة احتياطية دلوقتي، وبعدين احذف بعض الطلبات القديمة من الأرشيف أو فرّغ مساحة على جهازك.';
            } else if (location.protocol === 'file:') {
                reason = 'الملف متفتوح مباشرة من جهازك (file://) والمتصفح ده بيمنع تخزين البيانات لملفات محلية بالشكل ده. جرب: (1) استخدم متصفح تاني زي Firefox، أو (2) ارفع الملف على استضافة بسيطة أو Google Drive/GitHub Pages وافتحه من لينك (http/https).';
            } else if (err.name === 'SecurityError' || err.name === 'InvalidStateError') {
                reason = 'المتصفح رافض تخزين البيانات لهذه الصفحة، غالبًا بسبب وضع التصفح الخاص (Incognito/Private) أو إعدادات خصوصية شديدة. جرب تفتح الملف في نافذة عادية (مش خاصة).';
            }
            return { ok: false, reason, raw: err };
        }
    }

    function getItemType(code) {
        return String(code).trim().startsWith('515') ? 'استيراد' : 'محلي';
    }
    function getBadgeClass(type) {
        return type === 'استيراد' ? 'badge-import' : 'badge-local';
    }

    // ============ تحميل/حفظ البيانات الأساسية ============
    async function loadMasterData() {
        try {
            masterData = (await idbGet(MASTER_STORAGE_KEY)) || [];
        } catch (e) {
            console.error(e);
            masterData = [];
            showStatus('masterStatus', '⚠️ تعذّر قراءة البيانات المحفوظة من الجهاز.', 'warning');
        }
        renderMasterTable();
    }

    async function saveMasterData() {
        try {
            await idbSet(MASTER_STORAGE_KEY, masterData);
        } catch (err) {
            console.error(err);
            let health = await checkStorageHealth();
            let detail = health.ok ? ('تفاصيل الخطأ: ' + (err.name || '') + ' - ' + (err.message || '')) : health.reason;
            showStatus('masterStatus', '❌ تعذّر حفظ البيانات في تخزين الجهاز. ' + detail, 'danger');
        }
        renderMasterTable();
    }

    // ============ تحميل/حفظ سجل حركات المراجعة المتراكم (يبقى محفوظ على الجهاز بين الجلسات) ============
    async function loadAuditLog() {
        try {
            auditMovements = (await idbGet(AUDIT_LOG_STORAGE_KEY)) || [];
        } catch (e) {
            console.error(e);
            auditMovements = [];
        }
        try {
            let savedDocs = (await idbGet(AUDIT_ATTACHMENTS_STORAGE_KEY)) || [];
            auditAttachmentSet = new Set(savedDocs);
        } catch (e) {
            console.error(e);
            auditAttachmentSet = new Set();
        }
        updateAuditLogStatus();
        updateAuditRunButtonState();
    }

    async function saveAuditLog() {
        try {
            await idbSet(AUDIT_LOG_STORAGE_KEY, auditMovements);
        } catch (err) {
            console.error(err);
            showStatus('auditStatus', '⚠️ تم تحميل الحركات بنجاح لكن تعذّر حفظها بشكل دائم على الجهاز.', 'warning');
        }
    }

    async function saveAuditAttachments() {
        try {
            await idbSet(AUDIT_ATTACHMENTS_STORAGE_KEY, Array.from(auditAttachmentSet));
        } catch (err) {
            console.error(err);
        }
    }

    // مفتاح تمييز الصف بيجمع كل حقوله المهمة، عشان لو نفس الشيت اتحمّل مرتين متتكررش نفس الحركة في السجل التراكمي
    function buildAuditRowKey(r) {
        return [r.material, r.moveType, r.qty, r.materialDoc, r.employee, r.valuationType, r.postingDateRaw].join('||');
    }

    function mergeAuditRows(newRows) {
        let existingKeys = new Set(auditMovements.map(buildAuditRowKey));
        let addedCount = 0;
        newRows.forEach(r => {
            let key = buildAuditRowKey(r);
            if (!existingKeys.has(key)) {
                auditMovements.push(r);
                existingKeys.add(key);
                addedCount++;
            }
        });
        return addedCount;
    }

    function updateAuditLogStatus() {
        let el = document.getElementById('auditFilesStatus');
        if (!el) return;
        el.innerHTML = `📊 إجمالي الحركات المحفوظة تراكميًا على هذا الجهاز: <b>${auditMovements.length}</b> حركة`
            + (auditAttachmentSet.size > 0 ? ` — 📎 ${auditAttachmentSet.size} رقم مستند مسجّل له مرفق` : '')
            + ` — <a href="#" onclick="clearAuditLog(); return false;" class="text-danger">🗑️ مسح السجل التراكمي</a>`;
    }

    async function clearAuditLog() {
        if (!confirm('هيتم مسح كل الحركات وأرقام المرفقات المحفوظة تراكميًا على الجهاز ده. الشيتات الأصلية عندك لسه موجودة وممكن ترفعها تاني. تحب تكمل؟')) return;
        auditMovements = [];
        auditAttachmentSet = new Set();
        await saveAuditLog();
        await saveAuditAttachments();
        updateAuditLogStatus();
        updateAuditRunButtonState();
        document.getElementById('auditResults').classList.add('d-none');
        showStatus('auditStatus', '✅ تم مسح السجل التراكمي بالكامل.', 'success');
    }

    function findMasterIndexByCode(code) {
        let c = String(code).trim();
        return masterData.findIndex(item => String(item.code).trim() === c);
    }

    // بيبني مفتاح فريد بيجمع الكود مع الموقع والشركة مع بعض، عشان نقدر نفرّق بين نفس الكود
    // لما يكون مسجّل أكتر من مرة في مواقع/شركات مختلفة (وده وارد جدًا حسب طبيعة العمل)
    function makeItemKey(code, location, company) {
        return String(code || '').trim() + '||' + String(location || '').trim() + '||' + String(company || '').trim();
    }

    function findMasterIndexByKey(code, location, company) {
        let key = makeItemKey(code, location, company);
        return masterData.findIndex(item => makeItemKey(item.code, item.location, item.company) === key);
    }

    // فهرس سريع بمفتاح (كود+موقع+شركة) عشان نقدر نطابق الصف الصحيح بالظبط حتى لو الكود متكرر في مواقع تانية
    function buildMasterKeyIndex() {
        let map = new Map();
        masterData.forEach((item, index) => {
            map.set(makeItemKey(item.code, item.location, item.company), index);
        });
        return map;
    }

    // بيجمع كل الـ indexes اللي بتشترك في نفس الكود (حتى لو مواقع مختلفة) عشان نكتشف حالات تكرار الكود
    // ونقدر نميّز: هل الكود ده فريد (نقدر نطابقه حتى من غير موقع/شركة)، ولا متكرر ومحتاج تحديد دقيق؟
    function buildMasterCodeGroups() {
        let map = new Map();
        masterData.forEach((item, index) => {
            let c = String(item.code).trim();
            if (!map.has(c)) map.set(c, []);
            map.get(c).push(index);
        });
        return map;
    }

    // بيجمع الـ indexes بمفتاح (كود+شركة) مع بعض، عشان لو نفس الكود موجود في أكتر من شركة، نطابق بس الشركة
    // الصحيحة المذكورة في الشيت (حتى لو نفس الكود ده متكرر في أكتر من موقع جوه نفس الشركة، هيتجمعوا مع بعض هنا)
    function buildMasterCodeCompanyGroups() {
        let map = new Map();
        masterData.forEach((item, index) => {
            let key = String(item.code).trim() + '||' + String(item.company || '').trim();
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(index);
        });
        return map;
    }

    // بيجمع الـ indexes بمفتاح (كود+شركة+موقع) مع بعض، عشان لو نفس الكود متكرر في أكتر من موقع جوه نفس
    // الشركة (مثلاً شركة واحدة ليها أكتر من مخزن)، ولو الشيت محدد الموقع كمان، نطابق بالظبط مع الموقع ده
    function buildMasterCodeCompanyLocationGroups() {
        let map = new Map();
        masterData.forEach((item, index) => {
            let key = String(item.code).trim() + '||' + String(item.company || '').trim() + '||' + String(item.location || '').trim();
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(index);
        });
        return map;
    }

    // بيجمع الـ indexes بمفتاح (كود+شركة) بس للأصناف اللي مسجّلة بالبيانات الأساسية من غير موقع تخزين (فاضي)
    // بنستخدمها لما الشيت المرفوع فيه موقع، لكن الصنف نفسه في البيانات الأساسية معندوش موقع مسجّل أصلاً،
    // عشان منرفضش المطابقة غلط بسبب موقع مش موجود في الأساس نقارن بيه
    function buildMasterCodeCompanyBlankLocationGroups() {
        let map = new Map();
        masterData.forEach((item, index) => {
            if (String(item.location || '').trim() !== '') return;
            let key = String(item.code).trim() + '||' + String(item.company || '').trim();
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(index);
        });
        return map;
    }

    // بيبني فهرس سريع (كود -> index) عشان البحث يبقى فوري بدل ما نمسح كل الصفوف من الأول في كل مرة.
    // ده أساسي مع آلاف الأصناف، لأن البحث الخطي العادي بيبقى بطيء جداً (ممكن يجمّد المتصفح) لما بترفع شيت كبير.
    // ملحوظة: بيفيد بس لو الكود مضمون إنه فريد. لو الكود ممكن يتكرر في مواقع مختلفة، استخدم buildMasterKeyIndex بدلاً منها.
    function buildMasterCodeIndex() {
        let map = new Map();
        masterData.forEach((item, index) => {
            map.set(String(item.code).trim(), index);
        });
        return map;
    }

    // بيملأ قائمة اختيار الشركة في شاشة تحديث الرصيد بكل الشركات الموجودة فعليًا بالبيانات الأساسية
    function populateStockCompanyFilter() {
        let select = document.getElementById('stockCompanyFilter');
        if (!select) return;
        let previousValue = select.value;
        let companies = Array.from(new Set(masterData.map(item => String(item.company || '').trim()).filter(c => c !== ''))).sort((a, b) => a.localeCompare('ar'));
        let optionsHtml = '<option value="">-- كل الشركات (حسب عمود الشركة في الشيت نفسه) --</option>';
        companies.forEach(c => {
            optionsHtml += `<option value="${c}">${c}</option>`;
        });
        select.innerHTML = optionsHtml;
        if (companies.includes(previousValue)) select.value = previousValue;
    }

    // لما المستخدم يغيّر الشركة المختارة بعد ما يكون رفع شيت بالفعل، نعيد المعاينة على طول بنفس الملف المحفوظ
    function onStockCompanyFilterChange() {
        if (pendingStockRows) {
            let unmatchedCount = previewStockData(pendingStockRows);
            if (unmatchedCount > 0) {
                showStatus('stockStatus', `⚠️ تم إعادة المطابقة حسب الشركة المختارة: ${unmatchedCount} كود مش موجود بالبيانات الأساسية لهذه الشركة. راجع المعاينة تحت.`, 'warning');
            } else {
                showStatus('stockStatus', `✅ تم إعادة المطابقة حسب الشركة المختارة بنجاح. اضغط "تأكيد الرصيد وتوليد تقرير الطلب".`, 'success');
            }
        }
    }

    function renderMasterTable() {
        document.getElementById('masterCount').textContent = masterData.length;
        let searchBox = document.getElementById('masterSearchInput');
        if (searchBox) searchBox.value = '';
        populateStockCompanyFilter();
        let body = document.getElementById('masterBody');

        if (masterData.length === 0) {
            body.innerHTML = `<tr><td colspan="10" class="text-muted py-4">لا توجد بيانات أساسية بعد. ارفع شيت أو أضف صنف يدويًا.</td></tr>`;
            return;
        }

        let html = '';
        masterData.forEach((item, index) => {
            let type = getItemType(item.code);
            html += `<tr>
                <td>${item.code}</td>
                <td>${item.desc}</td>
                <td>${item.location || '-'}</td>
                <td>${item.company || '-'}</td>
                <td>${item.groupNum || '-'}</td>
                <td>${item.groupName || '-'}</td>
                <td><span class="badge ${getBadgeClass(type)}">${type}</span></td>
                <td>${item.minQty}</td>
                <td>${item.maxQty}</td>
                <td>
                    <button class="btn btn-outline-primary btn-sm" onclick="editMasterItem(${index})">✏️ تعديل</button>
                    <button class="btn btn-outline-danger btn-sm" onclick="deleteMasterItem(${index})">🗑️ حذف</button>
                </td>
            </tr>`;
        });
        body.innerHTML = html;
    }

    function showStatus(elementId, message, type) {
        let box = document.getElementById(elementId);
        box.className = `alert alert-${type} py-2 px-3`;
        box.textContent = message;
    }

    // بحث لحظي في أي جدول: بيفلتر الصفوف حسب أي نص فيها (يغطي الكود/الوصف/الشركة تلقائيًا لأنهم أعمدة في نفس الصف)
    function filterTable(tbodyId, query) {
        let term = query.trim().toLowerCase();
        let rows = document.getElementById(tbodyId).querySelectorAll('tr');
        rows.forEach(row => {
            let text = row.textContent.toLowerCase();
            row.style.display = (term === '' || text.includes(term)) ? '' : 'none';
        });
    }

    // ============ إضافة/تعديل صنف يدوي ============
    function addOrUpdateManualItem() {
        let code = document.getElementById('manualCode').value.trim();
        let desc = document.getElementById('manualDesc').value.trim();
        let location = document.getElementById('manualLocation').value.trim();
        let company = document.getElementById('manualCompany').value.trim();
        let groupNum = document.getElementById('manualGroupNum').value.trim();
        let groupName = document.getElementById('manualGroupName').value.trim();
        let minQty = parseFloat(document.getElementById('manualMin').value || 0);
        let maxQty = parseFloat(document.getElementById('manualMax').value || 0);

        if (!code) {
            showStatus('masterStatus', '⚠️ برجاء إدخال كود المادة.', 'warning');
            return;
        }

        let existingIndex = findMasterIndexByKey(code, location, company);
        if (existingIndex >= 0) {
            masterData[existingIndex] = { code, desc, location, company, groupNum, groupName, minQty, maxQty };
            showStatus('masterStatus', `✅ تم تحديث بيانات الصنف "${code}" (${location || 'بدون موقع'}).`, 'success');
        } else {
            masterData.push({ code, desc, location, company, groupNum, groupName, minQty, maxQty });
            showStatus('masterStatus', `✅ تم إضافة الصنف "${code}" للبيانات الأساسية.`, 'success');
        }

        saveMasterData();

        document.getElementById('manualCode').value = '';
        document.getElementById('manualDesc').value = '';
        document.getElementById('manualLocation').value = '';
        document.getElementById('manualCompany').value = '';
        document.getElementById('manualGroupNum').value = '';
        document.getElementById('manualGroupName').value = '';
        document.getElementById('manualMin').value = '';
        document.getElementById('manualMax').value = '';
    }

    function editMasterItem(index) {
        let item = masterData[index];
        document.getElementById('manualCode').value = item.code;
        document.getElementById('manualDesc').value = item.desc;
        document.getElementById('manualLocation').value = item.location || '';
        document.getElementById('manualCompany').value = item.company || '';
        document.getElementById('manualGroupNum').value = item.groupNum || '';
        document.getElementById('manualGroupName').value = item.groupName || '';
        document.getElementById('manualMin').value = item.minQty;
        document.getElementById('manualMax').value = item.maxQty;
        window.scrollTo({ top: document.getElementById('manualCode').offsetTop - 100, behavior: 'smooth' });
        showStatus('masterStatus', `✏️ عدّل القيم فوق واضغط "حفظ" لتحديث "${item.code}".`, 'secondary');
    }

    function deleteMasterItem(index) {
        let item = masterData[index];
        if (confirm(`هل أنت متأكد من حذف الصنف "${item.code}" من البيانات الأساسية؟`)) {
            masterData.splice(index, 1);
            saveMasterData();
        }
    }

    function clearAllMasterData() {
        if (masterData.length === 0) return;
        if (confirm('هل أنت متأكد من مسح كل البيانات الأساسية؟ الإجراء ده مش قابل للتراجع.')) {
            masterData = [];
            saveMasterData();
            showStatus('masterStatus', '🗑️ تم مسح كل البيانات الأساسية.', 'warning');
        }
    }

    // يقرأ قيمة عمود من الصف بمرونة: بيتجاهل المسافات الزيادة وحالة الأحرف اللاتينية،
    // وبيدور على أي اسم من قائمة الأسماء المحتملة حتى لو مكتوب بشكل مختلف شوية في الشيت
    function getFieldValue(row, aliases) {
        let normalizedKeys = Object.keys(row).map(k => ({ original: k, norm: String(k).trim().toLowerCase() }));
        for (let alias of aliases) {
            let aliasNorm = alias.trim().toLowerCase();
            let match = normalizedKeys.find(k => k.norm === aliasNorm);
            if (match && row[match.original] !== undefined && row[match.original] !== '') {
                return row[match.original];
            }
        }
        return '';
    }

    const CODE_ALIASES = ['كود المادة', 'الكود', 'كود الصنف', 'كود', 'Code', 'code'];
    const DESC_ALIASES = ['الوصف', 'الاسم', 'اسم الصنف', 'الصنف', 'Description', 'description'];
    const MIN_ALIASES = ['الحد الأدنى', 'الحد الادنى', 'الحد الأدني', 'الحد الادني', 'Min', 'min'];
    const MAX_ALIASES = ['الحد الأقصى', 'الحد الاقصى', 'الحد الأقصي', 'الحد الاقصي', 'Max', 'max'];
    const STOCK_ALIASES = ['الرصيد الحالي', 'الرصيد', 'Stock', 'stock'];
    const LOCATION_ALIASES = ['موقع التخزين', 'الموقع', 'مكان التخزين', 'Location', 'location'];
    const COMPANY_ALIASES = ['الشركة', 'اسم الشركة', 'Company', 'company'];
    const GROUP_NUM_ALIASES = ['رقم المجموعة', 'كود المجموعة', 'Group Number', 'Group No', 'GroupNum', 'group number'];
    const GROUP_NAME_ALIASES = ['اسم المجموعة', 'المجموعة', 'Group Name', 'GroupName', 'group name'];

    // ============ رفع شيت البيانات الأساسية (إضافة/تحديث بالدمج) ============
    document.getElementById('masterFile').addEventListener('change', function (e) {
        let file = e.target.files[0];
        if (!file) return;

        showStatus('masterStatus', '⏳ جاري قراءة الملف...', 'secondary');
        let reader = new FileReader();

        reader.onerror = function () {
            showStatus('masterStatus', '❌ حصل خطأ أثناء قراءة الملف.', 'danger');
        };

        reader.onload = function (e) {
            try {
                if (typeof XLSX === 'undefined') {
                    throw new Error('مكتبة قراءة الإكسيل لم يتم تحميلها. تأكد من اتصال الإنترنت وحدّث الصفحة.');
                }
                let data = new Uint8Array(e.target.result);
                let workbook = XLSX.read(data, { type: 'array' });
                let worksheet = workbook.Sheets[workbook.SheetNames[0]];
                let jsonData = XLSX.utils.sheet_to_json(worksheet);

                if (jsonData.length === 0) {
                    showStatus('masterStatus', '⚠️ الشيت فارغ أو لا يحتوي على بيانات صالحة.', 'warning');
                    return;
                }

                let addedCount = 0;
                let updatedCount = 0;
                let skippedNoCodeCount = 0;
                let keyIndex = buildMasterKeyIndex(); // فهرس بمفتاح (كود+موقع+شركة) عشان الأكواد المتكررة في مواقع مختلفة تتحفظ كل واحدة لوحدها

                jsonData.forEach(row => {
                    let code = getFieldValue(row, CODE_ALIASES);
                    let desc = getFieldValue(row, DESC_ALIASES);
                    let location = getFieldValue(row, LOCATION_ALIASES);
                    let company = getFieldValue(row, COMPANY_ALIASES);
                    let groupNum = getFieldValue(row, GROUP_NUM_ALIASES);
                    let groupName = getFieldValue(row, GROUP_NAME_ALIASES);
                    let minQty = parseFloat(getFieldValue(row, MIN_ALIASES) || 0);
                    let maxQty = parseFloat(getFieldValue(row, MAX_ALIASES) || 0);

                    if (!code) { skippedNoCodeCount++; return; }
                    code = String(code).trim();

                    let key = makeItemKey(code, location, company);
                    let existingIndex = keyIndex.has(key) ? keyIndex.get(key) : -1;
                    if (existingIndex >= 0) {
                        masterData[existingIndex] = { code, desc, location, company, groupNum, groupName, minQty, maxQty };
                        updatedCount++;
                    } else {
                        masterData.push({ code, desc, location, company, groupNum, groupName, minQty, maxQty });
                        keyIndex.set(key, masterData.length - 1);
                        addedCount++;
                    }
                });

                saveMasterData();

                if (addedCount === 0 && updatedCount === 0) {
                    let detectedHeaders = Object.keys(jsonData[0] || {}).join('، ') || 'لا يوجد';
                    showStatus('masterStatus', `⚠️ لم يتم التعرف على أي صف صالح (${skippedNoCodeCount} صف اتجاهل لعدم وجود كود). الأعمدة الموجودة فعليًا في الشيت هي: [${detectedHeaders}]. تأكد إن اسم عمود الكود هو أحد الآتي: "كود المادة" أو "الكود" أو "Code".`, 'danger');
                } else {
                    showStatus('masterStatus', `✅ تم استيراد الشيت بنجاح: ${addedCount} صنف جديد، ${updatedCount} صنف تم تحديثه.` + (skippedNoCodeCount > 0 ? ` (تم تجاهل ${skippedNoCodeCount} صف بدون كود)` : ''), 'success');
                }
                e.target.value = '';
            } catch (err) {
                console.error(err);
                showStatus('masterStatus', '❌ حصل خطأ أثناء معالجة الملف: ' + err.message, 'danger');
            }
        };

        reader.readAsArrayBuffer(file);
    });

    // ============ رفع شيت تحديث الرصيد ============
    document.getElementById('stockFile').addEventListener('change', function (e) {
        let file = e.target.files[0];
        let confirmBtn = document.getElementById('confirmStockBtn');
        pendingStockRows = null;
        confirmBtn.disabled = true;

        if (!file) return;

        if (masterData.length === 0) {
            showStatus('stockStatus', '⚠️ لا توجد بيانات أساسية بعد. ارفع أو أضف البيانات الأساسية (كود / وصف / حد أدنى / حد أقصى) من التبويب الأول أولاً.', 'warning');
            e.target.value = '';
            return;
        }

        showStatus('stockStatus', '⏳ جاري قراءة الملف...', 'secondary');
        let reader = new FileReader();

        reader.onerror = function () {
            showStatus('stockStatus', '❌ حصل خطأ أثناء قراءة الملف.', 'danger');
        };

        reader.onload = function (e) {
            try {
                if (typeof XLSX === 'undefined') {
                    throw new Error('مكتبة قراءة الإكسيل لم يتم تحميلها. تأكد من اتصال الإنترنت وحدّث الصفحة.');
                }
                let data = new Uint8Array(e.target.result);
                let workbook = XLSX.read(data, { type: 'array' });
                let worksheet = workbook.Sheets[workbook.SheetNames[0]];
                let jsonData = XLSX.utils.sheet_to_json(worksheet);

                if (jsonData.length === 0) {
                    showStatus('stockStatus', '⚠️ الشيت فارغ أو لا يحتوي على بيانات صالحة.', 'warning');
                    return;
                }

                pendingStockRows = jsonData;
                let unmatchedCount = previewStockData(jsonData);
                confirmBtn.disabled = false;

                let anyCodeFound = jsonData.some(row => !!getFieldValue(row, CODE_ALIASES));
                if (!anyCodeFound) {
                    let detectedHeaders = Object.keys(jsonData[0] || {}).join('، ') || 'لا يوجد';
                    showStatus('stockStatus', `⚠️ لم يتم العثور على عمود الكود في الشيت. الأعمدة الموجودة: [${detectedHeaders}]. تأكد إن اسم عمود الكود هو "كود المادة" أو "الكود" أو "Code".`, 'danger');
                } else if (unmatchedCount > 0) {
                    showStatus('stockStatus', `⚠️ تم قراءة ${jsonData.length} صف، لكن ${unmatchedCount} كود منهم مش موجود بالبيانات الأساسية (هيتم تجاهلهم عند التقرير). راجع المعاينة تحت.`, 'warning');
                } else {
                    showStatus('stockStatus', `✅ تم قراءة ${jsonData.length} صف وربطهم بالبيانات الأساسية بنجاح. اضغط "تأكيد الرصيد وتوليد تقرير الطلب".`, 'success');
                }
            } catch (err) {
                console.error(err);
                showStatus('stockStatus', '❌ حصل خطأ أثناء معالجة الملف: ' + err.message, 'danger');
            }
        };

        reader.readAsArrayBuffer(file);
    });

    // منطق المطابقة الموحّد (كود + شركة + موقع) المستخدم في المعاينة وفي توليد التقرير النهائي.
    // بيرجع { matchedIndexes, locationConflict }:
    // - لو فيه تطابق دقيق (كود+شركة+موقع) بيرجعه.
    // - لو مفيش تطابق دقيق بس فيه صنف بنفس الكود والشركة ومفهوش موقع مسجل خالص بالبيانات الأساسية،
    //   بيعتبره تطابق (مفيش حاجة نقارن بيها أصلاً).
    // - لو فيه صنف بنفس الكود والشركة لكن موقعه مسجل ومختلف عن اللي في الشيت، ده تعارض حقيقي في الموقع.
    function matchStockRow(code, sheetCompany, sheetLocation, codeGroups, codeCompanyGroups, codeCompanyLocationGroups) {
        let locationConflict = false;
        let matchedIndexes = [];

        if (sheetCompany && sheetLocation) {
            let exactKey = code + '||' + String(sheetCompany).trim() + '||' + String(sheetLocation).trim();
            let exactMatches = codeCompanyLocationGroups.get(exactKey) || [];
            if (exactMatches.length > 0) {
                matchedIndexes = exactMatches;
            } else {
                let companyKey = code + '||' + String(sheetCompany).trim();
                let companyMatches = codeCompanyGroups.get(companyKey) || [];
                let noLocationMatches = companyMatches.filter(idx => String(masterData[idx].location || '').trim() === '');
                if (noLocationMatches.length > 0) {
                    matchedIndexes = noLocationMatches;
                } else if (companyMatches.length > 0) {
                    locationConflict = true;
                }
            }
        } else if (sheetCompany) {
            let companyKey = code + '||' + String(sheetCompany).trim();
            matchedIndexes = codeCompanyGroups.get(companyKey) || [];
        } else {
            matchedIndexes = codeGroups.get(code) || [];
        }

        return { matchedIndexes, locationConflict };
    }

    // معاينة بيانات الرصيد المرفوعة مع ربطها بالبيانات الأساسية. بترجع عدد الأكواد الغير مطابقة
    // ملحوظة مهمة: ترتيب أولوية المطابقة كالتالي:
    // 1) لو الشيت فيه شركة وموقع مع بعض: نطابق بالكود+الشركة+الموقع بالظبط (أدق حالة)
    // 2) لو الشيت فيه شركة بس من غير موقع: نطابق بالكود+الشركة، ونعرض كل مواقع الشركة دي للكود ده
    // 3) لو الشيت مفيهوش شركة خالص: نطابق بالكود بس، ونعرض كل النسخ الموجودة (أي شركة/موقع)
    function previewStockData(rows) {
        let html = '';
        let unmatchedCount = 0;
        let searchBox = document.getElementById('stockSearchInput');
        if (searchBox) searchBox.value = '';
        let codeGroups = buildMasterCodeGroups();                       // كود -> كل الـ indexes (لأي شركة)
        let codeCompanyGroups = buildMasterCodeCompanyGroups();          // (كود+شركة) -> الـ indexes بتاعت نفس الشركة بس
        let codeCompanyLocationGroups = buildMasterCodeCompanyLocationGroups(); // (كود+شركة+موقع) -> مطابقة دقيقة بالموقع كمان
        unmatchedStockItems = []; // بنعيد بناء القائمة مع كل رفعة شيت جديدة

        // لو المستخدم اختار شركة معينة من القائمة، بنعتمد عليها هي في المطابقة لكل صفوف الشيت
        // (بدل عمود الشركة اللي في الشيت نفسه)، عشان نضمن إن الشيت ده هيتحدد بشركة واحدة بس
        // حتى لو الشيت مفيهوش عمود شركة أصلاً أو الاسم فيه مكتوب بشكل مختلف شوية
        let forcedCompanyEl = document.getElementById('stockCompanyFilter');
        let forcedCompany = forcedCompanyEl ? forcedCompanyEl.value.trim() : '';

        rows.forEach(row => {
            let code = getFieldValue(row, CODE_ALIASES);
            let currentStock = parseFloat(getFieldValue(row, STOCK_ALIASES) || 0);
            if (!code) return;
            code = String(code).trim();
            let type = getItemType(code);
            let sheetCompany = forcedCompany || getFieldValue(row, COMPANY_ALIASES);
            let sheetLocation = getFieldValue(row, LOCATION_ALIASES);

            let matchedIndexes = [];
            let companyExistsButLocationAmbiguous = false;

            let matchResult = matchStockRow(code, sheetCompany, sheetLocation, codeGroups, codeCompanyGroups, codeCompanyLocationGroups);
            matchedIndexes = matchResult.matchedIndexes;
            companyExistsButLocationAmbiguous = matchResult.locationConflict;

            if (matchedIndexes.length > 0) {
                matchedIndexes.forEach(masterIndex => {
                    let master = masterData[masterIndex];
                    // بنعرض الموقع والشركة من الشيت المرفوع نفسه (لو موجودين)، مش من البيانات الأساسية،
                    // عشان الشاشة تعكس بالظبط اللي مكتوب في شيت تحديث الرصيد
                    let location = sheetLocation || master.location || '-';
                    let company = sheetCompany || master.company || '-';
                    html += `<tr>
                        <td>${code}</td>
                        <td>${master.desc}</td>
                        <td>${location}</td>
                        <td>${company}</td>
                        <td>${master.groupNum || '-'}</td>
                        <td>${master.groupName || '-'}</td>
                        <td><span class="badge ${getBadgeClass(type)}">${type}</span></td>
                        <td>${currentStock}</td>
                        <td>${master.minQty}</td>
                        <td>${master.maxQty}</td>
                        <td><span class="badge bg-success">✔️ مطابق</span></td>
                    </tr>`;
                });
            } else {
                unmatchedCount++;
                let sheetDesc = getFieldValue(row, DESC_ALIASES) || '-';
                let reason;
                if (companyExistsButLocationAmbiguous) {
                    reason = `الكود موجود في شركة "${sheetCompany}" لكن في موقع تخزين مختلف عن "${sheetLocation}" المذكور بالشيت`;
                } else {
                    let existsElsewhere = sheetCompany && (codeGroups.get(code) || []).length > 0;
                    reason = existsElsewhere
                        ? `الكود موجود بالبيانات الأساسية بس في شركة تانية مش "${sheetCompany}"`
                        : 'غير موجود بالبيانات الأساسية خالص';
                }
                unmatchedStockItems.push({ code, desc: sheetDesc, currentStock, reason });
                let rowBadge = (companyExistsButLocationAmbiguous || (sheetCompany && (codeGroups.get(code) || []).length > 0))
                    ? `<span class="badge bg-warning text-dark">⚠️ ${reason}</span>`
                    : `<span class="badge badge-missing">❌ غير موجود بالبيانات الأساسية</span>`;
                html += `<tr class="table-secondary">
                    <td>${code}</td>
                    <td>-</td>
                    <td>-</td>
                    <td>-</td>
                    <td>-</td>
                    <td>-</td>
                    <td>-</td>
                    <td>${currentStock}</td>
                    <td>-</td>
                    <td>-</td>
                    <td>${rowBadge}</td>
                </tr>`;
            }
        });

        document.getElementById('stockPreviewBody').innerHTML = html || `<tr><td colspan="11" class="text-muted py-4">لا توجد بيانات صالحة في الملف.</td></tr>`;
        renderUnmatchedItems();
        return unmatchedCount;
    }

    // ============ شاشة الأصناف غير الموجودة بالبيانات الأساسية ============
    function renderUnmatchedItems() {
        let searchBox = document.getElementById('unmatchedSearchInput');
        if (searchBox) searchBox.value = '';
        let fromInput = document.getElementById('unmatchedFromInput');
        let toInput = document.getElementById('unmatchedToInput');
        if (fromInput) fromInput.value = '';
        if (toInput) toInput.value = '';
        let statusEl = document.getElementById('unmatchedStatus');
        if (statusEl) statusEl.classList.add('d-none');

        let countEl = document.getElementById('unmatchedCount');
        if (countEl) countEl.textContent = unmatchedStockItems.length;

        unmatchedItemsShown = unmatchedStockItems;
        renderUnmatchedTable(unmatchedStockItems);
    }

    function renderUnmatchedTable(items) {
        let html = '';
        items.forEach(item => {
            let existsElsewhere = item.reason && item.reason.indexOf('شركة تانية') >= 0;
            let badge = existsElsewhere
                ? `<span class="badge bg-warning text-dark">${item.reason}</span>`
                : `<span class="badge badge-missing">${item.reason || 'غير موجود بالبيانات الأساسية'}</span>`;
            html += `<tr>
                <td>${item.code}</td>
                <td>${item.desc || '-'}</td>
                <td>${item.currentStock}</td>
                <td>${badge}</td>
            </tr>`;
        });
        document.getElementById('unmatchedItemsBody').innerHTML = html || `<tr><td colspan="4" class="text-muted py-4">لا توجد أصناف غير مطابقة حاليًا. برجاء رفع شيت تحديث الرصيد من الشاشة السابقة.</td></tr>`;
    }

    // بيولّد تقرير مخصص: الأصناف غير الموجودة بالبيانات الأساسية واللي رصيدها في نطاق معين (من كذا لحد كذا، شامل الطرفين)
    // (مش زي التقرير التلقائي اللي بيعتمد على حد أدنى/أقصى، لأن الأصناف دي أساسًا معندهاش حد أدنى/أقصى محفوظ)
    function generateLowStockReport() {
        let fromInput = document.getElementById('unmatchedFromInput');
        let toInput = document.getElementById('unmatchedToInput');
        let fromVal = fromInput.value.trim() === '' ? null : parseFloat(fromInput.value);
        let toVal = toInput.value.trim() === '' ? null : parseFloat(toInput.value);

        if (fromVal === null && toVal === null) {
            alert('من فضلك اكتب قيمة واحدة على الأقل (من / إلى).');
            return;
        }
        if (fromVal !== null && toVal !== null && fromVal > toVal) {
            alert('قيمة "من" لازم تكون أصغر من أو تساوي قيمة "إلى".');
            return;
        }

        let filtered = unmatchedStockItems.filter(item => {
            if (fromVal !== null && item.currentStock < fromVal) return false;
            if (toVal !== null && item.currentStock > toVal) return false;
            return true;
        });
        unmatchedItemsShown = filtered;
        renderUnmatchedTable(filtered);

        let rangeLabel = fromVal !== null && toVal !== null
            ? `من ${fromVal} إلى ${toVal}`
            : (fromVal !== null ? `${fromVal} فأكتر` : `${toVal} فأقل`);
        showStatus('unmatchedStatus', `تم عرض ${filtered.length} صنف من إجمالي ${unmatchedStockItems.length} برصيد ${rangeLabel}.`, filtered.length > 0 ? 'warning' : 'success');
    }

    function resetUnmatchedFilter() {
        let fromInput = document.getElementById('unmatchedFromInput');
        let toInput = document.getElementById('unmatchedToInput');
        if (fromInput) fromInput.value = '';
        if (toInput) toInput.value = '';
        unmatchedItemsShown = unmatchedStockItems;
        renderUnmatchedTable(unmatchedStockItems);
        let statusEl = document.getElementById('unmatchedStatus');
        if (statusEl) statusEl.classList.add('d-none');
    }

    function exportUnmatchedItemsToExcel() {
        if (!unmatchedItemsShown || unmatchedItemsShown.length === 0) {
            alert('لا توجد بيانات لتصديرها.');
            return;
        }
        let exportRows = unmatchedItemsShown.map(i => ({
            'كود المادة': i.code,
            'الوصف': i.desc || '-',
            'الرصيد الحالي': i.currentStock,
            'السبب': i.reason || 'غير موجود بالبيانات الأساسية'
        }));
        let worksheet = XLSX.utils.json_to_sheet(exportRows);
        let workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'أصناف غير موجودة بالبيانات الأساسية');
        XLSX.writeFile(workbook, 'أصناف_غير_موجودة_بالبيانات_الأساسية.xlsx');
    }

    // ============ تأكيد الرصيد وتوليد تقرير طلب الشراء ============
    function confirmStockUpdate() {
        if (!pendingStockRows) {
            showStatus('stockStatus', '⚠️ لا يوجد ملف رصيد تم قراءته بعد.', 'warning');
            return;
        }

        try {
            generatedOrderItems = [];
            let reportHtml = '';
            let searchBox = document.getElementById('reportSearchInput');
            if (searchBox) searchBox.value = '';
            let codeGroups = buildMasterCodeGroups();                       // كود -> كل الـ indexes (لأي شركة)
            let codeCompanyGroups = buildMasterCodeCompanyGroups();          // (كود+شركة) -> الـ indexes بتاعت نفس الشركة بس
            let codeCompanyLocationGroups = buildMasterCodeCompanyLocationGroups(); // (كود+شركة+موقع) -> مطابقة دقيقة بالموقع كمان

            // نفس منطق الاختيار الصريح للشركة المستخدم في المعاينة، عشان التقرير النهائي يتوافق تمامًا معاها
            let forcedCompanyEl = document.getElementById('stockCompanyFilter');
            let forcedCompany = forcedCompanyEl ? forcedCompanyEl.value.trim() : '';

            pendingStockRows.forEach(row => {
                let code = getFieldValue(row, CODE_ALIASES);
                let currentStock = parseFloat(getFieldValue(row, STOCK_ALIASES) || 0);
                if (!code) return;
                code = String(code).trim();
                let sheetCompany = forcedCompany || getFieldValue(row, COMPANY_ALIASES);
                let sheetLocation = getFieldValue(row, LOCATION_ALIASES);

                let matchedIndexes = matchStockRow(code, sheetCompany, sheetLocation, codeGroups, codeCompanyGroups, codeCompanyLocationGroups).matchedIndexes;
                if (matchedIndexes.length === 0) return; // تجاهل الأكواد الغير مطابقة (كود/شركة/موقع) بالبيانات الأساسية

                // بنولّد سطر تقرير مستقل لكل نسخة من الكود موجودة فعليًا بالبيانات الأساسية (نستخدمها للأصناف/الحدود بس)
                matchedIndexes.forEach(masterIndex => {
                    let master = masterData[masterIndex];
                    let type = getItemType(code);
                    let badgeClass = getBadgeClass(type);
                    // بنعرض الموقع والشركة من الشيت المرفوع نفسه (لو موجودين)، مش من البيانات الأساسية
                    let location = sheetLocation || master.location || '-';
                    let company = sheetCompany || master.company || '-';

                    if (currentStock < master.minQty) {
                        let reqQty = master.maxQty - currentStock;
                        if (reqQty <= 0) reqQty = master.minQty;

                        let priorityText, priorityClass;
                        if (currentStock === 0) {
                            priorityText = "🚨 مهم ومستعجل جداً (الرصيد صفر)";
                            priorityClass = "priority-high";
                        } else {
                            priorityText = "⚠️ مهم (تحت الحد الأدنى)";
                            priorityClass = "priority-normal";
                        }

                        generatedOrderItems.push({
                            code, desc: master.desc, location, company, groupNum: master.groupNum || '', groupName: master.groupName || '', type, currentStock, reqQty, notes: priorityText
                        });

                        reportHtml += `<tr class="${priorityClass}">
                            <td>${code}</td>
                            <td>${master.desc}</td>
                            <td>${location}</td>
                            <td>${company}</td>
                            <td>${master.groupNum || '-'}</td>
                            <td>${master.groupName || '-'}</td>
                            <td><span class="badge ${badgeClass}">${type}</span></td>
                            <td>${currentStock}</td>
                            <td class="fw-bold text-primary">${reqQty}</td>
                            <td>${priorityText}</td>
                        </tr>`;
                    }
                });
            });

            if (generatedOrderItems.length > 0) {
                document.getElementById('reportBody').innerHTML = reportHtml;
            } else {
                document.getElementById('reportBody').innerHTML = `<tr><td colspan="10" class="text-success py-4">🎉 ممتاز! لا توجد مواد تحت الحد الأدنى، المخازن مكتملة تماماً.</td></tr>`;
            }

            showStatus('stockStatus', '✅ تم تأكيد الرصيد وتوليد التقرير بنجاح! انتقل لتبويب "تقرير طلب الشراء المقترح".', 'success');
        } catch (err) {
            console.error(err);
            showStatus('stockStatus', '❌ حصل خطأ أثناء توليد التقرير: ' + err.message, 'danger');
        }
    }

    // ============ حفظ طلب الشراء في أرشيف الجهاز (IndexedDB) ============
    async function savePurchaseOrder() {
        if (generatedOrderItems.length === 0) {
            alert("لا توجد بيانات بطلب الشراء لحفظها!");
            return;
        }

        let nameInput = document.getElementById('orderNameInput');
        let orderName = nameInput.value.trim();
        let newOrder = {
            id: 'PO-' + Math.floor(1000 + Math.random() * 9000),
            name: orderName || ('طلب بتاريخ ' + new Date().toLocaleDateString('ar-EG')),
            date: new Date().toLocaleString('ar-EG'),
            itemsCount: generatedOrderItems.length,
            items: generatedOrderItems
        };

        try {
            let savedOrders = await getSavedOrders();
            savedOrders.push(newOrder);
            await idbSet(ORDERS_STORAGE_KEY, savedOrders);
            alert(`تم حفظ الطلب "${newOrder.name}" بنجاح في الأرشيف برقم: ${newOrder.id}`);
            nameInput.value = '';
            loadArchive();
        } catch (err) {
            console.error(err);
            let health = await checkStorageHealth();
            let detail = health.ok ? ('تفاصيل الخطأ: ' + (err.name || '') + ' - ' + (err.message || '')) : health.reason;
            alert('❌ تعذّر حفظ الطلب في الأرشيف.\n\n' + detail + '\n\nخد نسخة احتياطية للبيانات فورًا من الزر اللي فوق قبل ما تحاول تاني.');
        }
    }

    // ============ تحميل وعرض أرشيف الطلبات المحفوظة ============
    async function getSavedOrders() {
        try {
            return (await idbGet(ORDERS_STORAGE_KEY)) || [];
        } catch (e) {
            console.error(e);
            return [];
        }
    }

    async function loadArchive() {
        let savedOrders = await getSavedOrders();
        let archiveHtml = '';

        if (savedOrders.length === 0) {
            document.getElementById('archiveBody').innerHTML = `<tr><td colspan="5" class="text-muted py-4">لا توجد طلبات محفوظة حالياً.</td></tr>`;
            return;
        }

        savedOrders.forEach((order, index) => {
            archiveHtml += `<tr>
                <td class="fw-bold">${order.name || '-'}</td>
                <td class="text-dark">${order.id}</td>
                <td>${order.date}</td>
                <td><span class="badge bg-secondary">${order.itemsCount} صنف</span></td>
                <td>
                    <button class="btn btn-info btn-sm text-white" onclick="viewArchiveItems(${index})">👁️ استعراض الأصناف</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteOrder(${index})">🗑️ حذف</button>
                </td>
            </tr>`;
        });

        document.getElementById('archiveBody').innerHTML = archiveHtml;
    }

    // يفتح شاشة (مودال) استعراض تفاصيل الطلب المحفوظ بدل رسالة alert
    async function viewArchiveItems(index) {
        let savedOrders = await getSavedOrders();
        let order = savedOrders[index];
        if (!order) return;

        document.getElementById('archiveViewModalTitle').textContent = `تفاصيل الطلب: ${order.name || order.id} — ${order.date}`;

        let rowsHtml = order.items.map(i => `<tr>
            <td>${i.code}</td>
            <td>${i.desc}</td>
            <td>${i.location || '-'}</td>
            <td>${i.company || '-'}</td>
            <td>${i.groupNum || '-'}</td>
            <td>${i.groupName || '-'}</td>
            <td><span class="badge ${getBadgeClass(i.type)}">${i.type}</span></td>
            <td>${i.currentStock}</td>
            <td class="fw-bold text-primary">${i.reqQty}</td>
            <td>${i.notes}</td>
        </tr>`).join('');

        document.getElementById('archiveViewBody').innerHTML = rowsHtml || `<tr><td colspan="10" class="text-muted py-3">لا توجد أصناف في هذا الطلب.</td></tr>`;

        document.getElementById('archiveViewExportBtn').onclick = function () {
            exportItemsToExcel(order.items, (order.name || order.id));
        };

        let modal = new bootstrap.Modal(document.getElementById('archiveViewModal'));
        modal.show();
    }

    async function deleteOrder(index) {
        if (confirm("هل أنت متأكد من حذف هذا الطلب من السجل؟")) {
            try {
                let savedOrders = await getSavedOrders();
                savedOrders.splice(index, 1);
                await idbSet(ORDERS_STORAGE_KEY, savedOrders);
                loadArchive();
            } catch (err) {
                console.error(err);
                alert('❌ تعذّر حذف الطلب. حاول تاني.');
            }
        }
    }

    // ============ تصدير إلى إكسيل ============
    function exportItemsToExcel(items, fileLabel) {
        if (!items || items.length === 0) {
            alert('لا توجد بيانات لتصديرها.');
            return;
        }
        let exportRows = items.map(i => ({
            'كود المادة': i.code,
            'الوصف': i.desc,
            'موقع التخزين': i.location || '',
            'الشركة': i.company || '',
            'رقم المجموعة': i.groupNum || '',
            'اسم المجموعة': i.groupName || '',
            'النوع': i.type,
            'الرصيد الحالي': i.currentStock,
            'الكمية المطلوبة': i.reqQty,
            'الملاحظات': i.notes
        }));
        let worksheet = XLSX.utils.json_to_sheet(exportRows);
        let workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'طلب الشراء');
        let safeLabel = String(fileLabel || 'تقرير').replace(/[\\/:*?"<>|]/g, '_');
        XLSX.writeFile(workbook, `${safeLabel}.xlsx`);
    }

    function exportReportToExcel() {
        exportItemsToExcel(generatedOrderItems, document.getElementById('orderNameInput').value.trim() || 'تقرير_طلب_الشراء');
    }

    // ============ نسخة احتياطية كاملة (تصدير/استيراد) ============
    async function downloadBackup() {
        let backup = {
            exportedAt: new Date().toLocaleString('ar-EG'),
            masterData: masterData,
            savedOrders: await getSavedOrders(),
            auditMovementsLog: auditMovements,
            auditAttachmentDocs: Array.from(auditAttachmentSet)
        };
        let blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        let url = URL.createObjectURL(blob);
        let a = document.createElement('a');
        let dateStr = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `نسخة_احتياطية_نظام_قطع_الغيار_${dateStr}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showStatus('backupStatus', '✅ تم تنزيل النسخة الاحتياطية. احتفظ بالملف في مكان آمن.', 'success');
    }

    document.getElementById('backupFile').addEventListener('change', function (e) {
        let file = e.target.files[0];
        if (!file) return;

        let reader = new FileReader();
        reader.onerror = function () {
            showStatus('backupStatus', '❌ حصل خطأ أثناء قراءة ملف النسخة الاحتياطية.', 'danger');
        };
        reader.onload = async function (e) {
            try {
                let backup = JSON.parse(e.target.result);
                if (!backup || !Array.isArray(backup.masterData) || !Array.isArray(backup.savedOrders)) {
                    throw new Error('صيغة ملف النسخة الاحتياطية غير صحيحة.');
                }

                if (!confirm(`هذا الملف يحتوي على ${backup.masterData.length} صنف أساسي و ${backup.savedOrders.length} طلب محفوظ${Array.isArray(backup.auditMovementsLog) ? ' و ' + backup.auditMovementsLog.length + ' حركة مراجعة مخزون' : ''}. استيراد النسخة الاحتياطية هيستبدل كل البيانات الحالية في النظام. هل تريد المتابعة؟`)) {
                    e.target.value = '';
                    return;
                }

                masterData = backup.masterData;
                await idbSet(MASTER_STORAGE_KEY, masterData);
                await idbSet(ORDERS_STORAGE_KEY, backup.savedOrders);

                if (Array.isArray(backup.auditMovementsLog)) {
                    auditMovements = backup.auditMovementsLog;
                    await idbSet(AUDIT_LOG_STORAGE_KEY, auditMovements);
                }
                if (Array.isArray(backup.auditAttachmentDocs)) {
                    auditAttachmentSet = new Set(backup.auditAttachmentDocs);
                    await idbSet(AUDIT_ATTACHMENTS_STORAGE_KEY, Array.from(auditAttachmentSet));
                }
                updateAuditLogStatus();
                updateAuditRunButtonState();

                renderMasterTable();
                loadArchive();
                showStatus('backupStatus', '✅ تم استيراد النسخة الاحتياطية بنجاح.', 'success');
                e.target.value = '';
            } catch (err) {
                console.error(err);
                showStatus('backupStatus', '❌ حصل خطأ أثناء استيراد النسخة الاحتياطية: ' + err.message, 'danger');
            }
        };
        reader.readAsText(file);
    });

    // ============================================================
    // مراجعة حركات المخزن (تحليل تصدير SAP - قائمة MB51)
    // ============================================================

    // أكواد الحركات المستخدمة في المراجعة (متفق عليها مسبقًا مع المستخدم)
    const MOVE_ISSUE_CUSTODY = 'Z41';      // صرف عهدة لموظف
    const MOVE_RETURN_CUSTODY = 'Z42';     // استلام عهدة من موظف
    const MOVE_SCRAP_TRANSFER = '551';     // تحويل لنفاية (تكهين)
    const MOVE_SEND_MAINTENANCE = 'Z61';   // صرف لأمر صيانة
    const DAMAGED_VALUATION_TYPES = ['SCRAP'];       // قيم "نوع التقييم" الدالة على إن الصنف تالف نهائيًا (يستوجب تكهين)
    const UNREPAIRED_VALUATION_TYPES = ['UNREPAIRED']; // قيم "نوع التقييم" الدالة على إن الصنف يستوجب دخول دورة صيانة

    const AUDIT_MATERIAL_ALIASES = ['المادة', 'كود المادة', 'Material', 'material'];
    const AUDIT_MATERIAL_DESC_ALIASES = ['وصف المادة', 'Material Description'];
    const AUDIT_QTY_ALIASES = ['الكمية بوحدة الإدخال', 'الكمية', 'Quantity', 'quantity'];
    const AUDIT_MOVE_TYPE_ALIASES = ['نوع الحركة', 'Movement Type', 'movement type'];
    const AUDIT_EMPLOYEE_ALIASES = ['الوصف', 'Description', 'description'];
    const AUDIT_VALUATION_ALIASES = ['نوع التقييم', 'Valuation Type', 'valuation type'];
    const AUDIT_POSTING_DATE_ALIASES = ['تاريخ الترحيل', 'Posting Date', 'posting date'];
    const AUDIT_DOC_ALIASES = ['مستند المادة', 'رقم مستند المادة', 'Material Document', 'material document'];
    const AUDIT_ATTACHMENT_DOC_ALIASES = ['مستند المادة', 'رقم مستند المادة', 'رقم المستند', 'Document', 'document'];

    let auditMovements = [];               // كل صفوف شيت MB51 بعد التطبيع
    let auditAttachmentSet = new Set();    // أرقام المستندات اللي ليها مرفق
    let auditResultsData = { 1: [], 2: [], 3: [], 4: [], 5: [] }; // آخر نتائج مراجعة تم توليدها (تُستخدم في التصدير)

    // تحويل قيمة تاريخ من الشيت (رقم تسلسلي إكسيل أو نص) إلى كائن Date، أو null لو تعذر ذلك
    function parseAuditDate(value) {
        if (value === undefined || value === null || value === '') return null;
        if (value instanceof Date) return value;
        if (typeof value === 'number') {
            // رقم تسلسلي بتاريخ إكسيل (الأيام من 30 ديسمبر 1899)
            let ms = Math.round((value - 25569) * 86400 * 1000);
            let d = new Date(ms);
            return isNaN(d.getTime()) ? null : d;
        }
        let str = String(value).trim();
        // صيغ شائعة: dd/mm/yyyy أو dd-mm-yyyy أو yyyy-mm-dd
        let m = str.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
        if (m) {
            let day = parseInt(m[1], 10), month = parseInt(m[2], 10), year = parseInt(m[3], 10);
            if (year < 100) year += 2000;
            let d = new Date(year, month - 1, day);
            return isNaN(d.getTime()) ? null : d;
        }
        let d2 = new Date(str);
        return isNaN(d2.getTime()) ? null : d2;
    }

    function formatAuditDate(dateObj) {
        if (!dateObj) return '-';
        let dd = String(dateObj.getDate()).padStart(2, '0');
        let mm = String(dateObj.getMonth() + 1).padStart(2, '0');
        let yyyy = dateObj.getFullYear();
        return `${dd}/${mm}/${yyyy}`;
    }

    function readAuditExcelFile(file, onRows) {
        let reader = new FileReader();
        reader.onerror = function () {
            showStatus('auditStatus', '❌ حصل خطأ أثناء قراءة الملف.', 'danger');
        };
        reader.onload = function (e) {
            try {
                if (typeof XLSX === 'undefined') {
                    throw new Error('مكتبة قراءة الإكسيل لم يتم تحميلها. تأكد من اتصال الإنترنت وحدّث الصفحة.');
                }
                let data = new Uint8Array(e.target.result);
                let workbook = XLSX.read(data, { type: 'array' });
                let worksheet = workbook.Sheets[workbook.SheetNames[0]];
                let jsonData = XLSX.utils.sheet_to_json(worksheet);
                onRows(jsonData);
            } catch (err) {
                showStatus('auditStatus', '❌ حصل خطأ أثناء قراءة الملف: ' + err.message, 'danger');
            }
        };
        reader.readAsArrayBuffer(file);
    }

    function updateAuditRunButtonState() {
        let btn = document.getElementById('runAuditBtn');
        if (btn) btn.disabled = auditMovements.length === 0;
    }

    document.getElementById('auditMovementsFile').addEventListener('change', function (e) {
        let file = e.target.files[0];
        if (!file) return;
        showStatus('auditStatus', '⏳ جاري قراءة ملف الحركات...', 'secondary');
        readAuditExcelFile(file, async function (rows) {
            let newRows = rows.map(row => ({
                material: String(getFieldValue(row, AUDIT_MATERIAL_ALIASES)).trim(),
                materialDesc: getFieldValue(row, AUDIT_MATERIAL_DESC_ALIASES) || '-',
                qty: Math.abs(parseFloat(getFieldValue(row, AUDIT_QTY_ALIASES)) || 0), // القيمة المطلقة لأن SAP بيصدّر كميات الصرف بإشارة سالبة
                moveType: String(getFieldValue(row, AUDIT_MOVE_TYPE_ALIASES)).trim(),
                employee: String(getFieldValue(row, AUDIT_EMPLOYEE_ALIASES) || '').trim(),
                valuationType: String(getFieldValue(row, AUDIT_VALUATION_ALIASES) || '').trim().toUpperCase(),
                postingDateRaw: getFieldValue(row, AUDIT_POSTING_DATE_ALIASES),
                postingDate: parseAuditDate(getFieldValue(row, AUDIT_POSTING_DATE_ALIASES)),
                materialDoc: String(getFieldValue(row, AUDIT_DOC_ALIASES)).trim()
            })).filter(r => r.material && r.moveType);
            let addedCount = mergeAuditRows(newRows);
            await saveAuditLog();
            updateAuditLogStatus();
            showStatus('auditStatus', `✅ تم قراءة ${newRows.length} حركة من الشيت، وإضافة ${addedCount} حركة جديدة للسجل التراكمي (${newRows.length - addedCount} كانت مسجّلة مسبقًا). اضغط "تشغيل المراجعة".`, 'success');
            updateAuditRunButtonState();
            e.target.value = '';
        });
    });

    document.getElementById('auditAttachmentsFile').addEventListener('change', function (e) {
        let file = e.target.files[0];
        if (!file) return;
        showStatus('auditStatus', '⏳ جاري قراءة شيت المرفقات...', 'secondary');
        readAuditExcelFile(file, async function (rows) {
            let docs = rows.map(row => String(getFieldValue(row, AUDIT_ATTACHMENT_DOC_ALIASES)).trim()).filter(v => v);
            let before = auditAttachmentSet.size;
            docs.forEach(d => auditAttachmentSet.add(d));
            await saveAuditAttachments();
            updateAuditLogStatus();
            showStatus('auditStatus', `✅ تم تحميل ${docs.length} رقم مستند، وإضافة ${auditAttachmentSet.size - before} رقم جديد للسجل التراكمي.`, 'success');
            e.target.value = '';
        });
    });

    // المحرك الرئيسي للمراجعة: بيحلل auditMovements ويطلع 4 تقارير منفصلة
    function runMovementAudit() {
        if (auditMovements.length === 0) return;

        // ---------- 1 و 2: حركات بدون مرفق ----------
        let result1 = auditMovements.filter(r => r.moveType === MOVE_ISSUE_CUSTODY && !auditAttachmentSet.has(r.materialDoc));
        let result2 = auditMovements.filter(r => r.moveType === MOVE_SCRAP_TRANSFER && !auditAttachmentSet.has(r.materialDoc));

        // ---------- 3: عهد بدون مرتجع (رصيد صافي لكل مادة+موظف) ----------
        let custodyMap = new Map(); // key: material||employee
        auditMovements.forEach(r => {
            if (r.moveType !== MOVE_ISSUE_CUSTODY && r.moveType !== MOVE_RETURN_CUSTODY) return;
            if (!r.employee) return; // مفيش موظف محدد، متعرفش نتابعها
            let key = r.material + '||' + r.employee;
            if (!custodyMap.has(key)) {
                custodyMap.set(key, { material: r.material, materialDesc: r.materialDesc, employee: r.employee, issuedQty: 0, returnedQty: 0, lastIssueDate: null });
            }
            let entry = custodyMap.get(key);
            if (r.moveType === MOVE_ISSUE_CUSTODY) {
                entry.issuedQty += r.qty;
                if (!entry.lastIssueDate || (r.postingDate && r.postingDate > entry.lastIssueDate)) entry.lastIssueDate = r.postingDate;
            } else {
                entry.returnedQty += r.qty;
            }
        });
        let result3 = [];
        custodyMap.forEach(entry => {
            let outstanding = entry.issuedQty - entry.returnedQty;
            if (outstanding > 0.0001) {
                result3.push({ ...entry, outstandingQty: outstanding });
            }
        });

        // ---------- 4: مرتجعات تالفة بدون تكهين (مطابقة بنفس المادة فقط) ----------
        let writeOffQtyByMaterial = new Map(); // إجمالي الكمية اللي اتكهنت لكل مادة
        auditMovements.forEach(r => {
            if (r.moveType !== MOVE_SCRAP_TRANSFER) return;
            writeOffQtyByMaterial.set(r.material, (writeOffQtyByMaterial.get(r.material) || 0) + r.qty);
        });
        let damagedReturnsByMaterial = new Map(); // مرتجعات تالفة لكل مادة، مرتبة بالتاريخ
        auditMovements.forEach(r => {
            if (r.moveType !== MOVE_RETURN_CUSTODY) return;
            if (!DAMAGED_VALUATION_TYPES.includes(r.valuationType)) return;
            if (!damagedReturnsByMaterial.has(r.material)) damagedReturnsByMaterial.set(r.material, []);
            damagedReturnsByMaterial.get(r.material).push(r);
        });
        let result4 = [];
        damagedReturnsByMaterial.forEach((returns, material) => {
            returns.sort((a, b) => (a.postingDate || 0) - (b.postingDate || 0));
            let remainingWriteOff = writeOffQtyByMaterial.get(material) || 0;
            returns.forEach(r => {
                if (remainingWriteOff >= r.qty - 0.0001) {
                    remainingWriteOff -= r.qty; // تم تكهينها بالكامل
                } else {
                    let outstandingQty = r.qty - Math.max(remainingWriteOff, 0);
                    remainingWriteOff = 0;
                    result4.push({ ...r, outstandingQty });
                }
            });
        });

        // ---------- 5: مرتجعات UNREPAIRED لسه مدخلتش دورة صيانة (مطابقة بنفس المادة فقط) ----------
        let maintenanceQtyByMaterial = new Map(); // إجمالي الكمية اللي دخلت أمر صيانة (Z61) لكل مادة
        auditMovements.forEach(r => {
            if (r.moveType !== MOVE_SEND_MAINTENANCE) return;
            maintenanceQtyByMaterial.set(r.material, (maintenanceQtyByMaterial.get(r.material) || 0) + r.qty);
        });
        let unrepairedReturnsByMaterial = new Map();
        auditMovements.forEach(r => {
            if (r.moveType !== MOVE_RETURN_CUSTODY) return;
            if (!UNREPAIRED_VALUATION_TYPES.includes(r.valuationType)) return;
            if (!unrepairedReturnsByMaterial.has(r.material)) unrepairedReturnsByMaterial.set(r.material, []);
            unrepairedReturnsByMaterial.get(r.material).push(r);
        });
        let result5 = [];
        unrepairedReturnsByMaterial.forEach((returns, material) => {
            returns.sort((a, b) => (a.postingDate || 0) - (b.postingDate || 0));
            let remainingMaintenance = maintenanceQtyByMaterial.get(material) || 0;
            returns.forEach(r => {
                if (remainingMaintenance >= r.qty - 0.0001) {
                    remainingMaintenance -= r.qty; // دخلت دورة صيانة بالكامل
                } else {
                    let outstandingQty = r.qty - Math.max(remainingMaintenance, 0);
                    remainingMaintenance = 0;
                    result5.push({ ...r, outstandingQty });
                }
            });
        });

        auditResultsData = { 1: result1, 2: result2, 3: result3, 4: result4, 5: result5 };
        renderAuditResults();
    }

    function renderAuditResults() {
        document.getElementById('auditResults').classList.remove('d-none');
        document.getElementById('auditCount1').textContent = auditResultsData[1].length;
        document.getElementById('auditCount2').textContent = auditResultsData[2].length;
        document.getElementById('auditCount3').textContent = auditResultsData[3].length;
        document.getElementById('auditCount4').textContent = auditResultsData[4].length;
        document.getElementById('auditCount5').textContent = auditResultsData[5].length;

        let body1 = document.getElementById('auditTable1');
        body1.innerHTML = auditResultsData[1].length === 0
            ? '<tr><td colspan="6" class="text-muted py-3">لا توجد حركات صرف عهدة بدون مرفق. ✅</td></tr>'
            : auditResultsData[1].map(r => `<tr>
                <td>${r.material}</td><td>${r.materialDesc}</td><td>${r.employee || '-'}</td>
                <td>${r.qty}</td><td>${formatAuditDate(r.postingDate)}</td><td>${r.materialDoc || '-'}</td>
            </tr>`).join('');

        let body2 = document.getElementById('auditTable2');
        body2.innerHTML = auditResultsData[2].length === 0
            ? '<tr><td colspan="5" class="text-muted py-3">لا توجد حركات تكهين بدون مرفق. ✅</td></tr>'
            : auditResultsData[2].map(r => `<tr>
                <td>${r.material}</td><td>${r.materialDesc}</td>
                <td>${r.qty}</td><td>${formatAuditDate(r.postingDate)}</td><td>${r.materialDoc || '-'}</td>
            </tr>`).join('');

        let body3 = document.getElementById('auditTable3');
        body3.innerHTML = auditResultsData[3].length === 0
            ? '<tr><td colspan="7" class="text-muted py-3">لا توجد عهد مفتوحة بدون مرتجع. ✅</td></tr>'
            : auditResultsData[3].map(r => `<tr>
                <td>${r.material}</td><td>${r.materialDesc}</td><td>${r.employee}</td>
                <td>${r.issuedQty}</td><td>${r.returnedQty}</td><td class="fw-bold text-danger">${r.outstandingQty}</td>
                <td>${formatAuditDate(r.lastIssueDate)}</td>
            </tr>`).join('');

        let body4 = document.getElementById('auditTable4');
        body4.innerHTML = auditResultsData[4].length === 0
            ? '<tr><td colspan="7" class="text-muted py-3">لا توجد مرتجعات تالفة بدون تكهين. ✅</td></tr>'
            : auditResultsData[4].map(r => `<tr>
                <td>${r.material}</td><td>${r.materialDesc}</td><td>${r.employee || '-'}</td>
                <td>${r.outstandingQty}</td><td>${r.valuationType}</td><td>${formatAuditDate(r.postingDate)}</td><td>${r.materialDoc || '-'}</td>
            </tr>`).join('');

        let body5 = document.getElementById('auditTable5');
        body5.innerHTML = auditResultsData[5].length === 0
            ? '<tr><td colspan="6" class="text-muted py-3">لا توجد مرتجعات محتاجة صيانة بدون دخول دورة صيانة. ✅</td></tr>'
            : auditResultsData[5].map(r => `<tr>
                <td>${r.material}</td><td>${r.materialDesc}</td><td>${r.employee || '-'}</td>
                <td>${r.outstandingQty}</td><td>${formatAuditDate(r.postingDate)}</td><td>${r.materialDoc || '-'}</td>
            </tr>`).join('');

        let totalIssues = auditResultsData[1].length + auditResultsData[2].length + auditResultsData[3].length + auditResultsData[4].length + auditResultsData[5].length;
        if (totalIssues === 0) {
            showStatus('auditStatus', '✅ المراجعة تمت ولم يتم اكتشاف أي ملاحظات.', 'success');
        } else {
            showStatus('auditStatus', `⚠️ المراجعة تمت واكتُشفت ${totalIssues} ملاحظة. راجع الجداول تحت.`, 'warning');
        }
    }

    function exportAuditSection(sectionNum) {
        let rows = auditResultsData[sectionNum] || [];
        if (rows.length === 0) {
            alert('لا توجد بيانات لتصديرها.');
            return;
        }
        let exportRows, sheetName, fileName;
        if (sectionNum === 1) {
            exportRows = rows.map(r => ({ 'كود المادة': r.material, 'الوصف': r.materialDesc, 'الموظف': r.employee, 'الكمية': r.qty, 'تاريخ الترحيل': formatAuditDate(r.postingDate), 'رقم المستند': r.materialDoc }));
            sheetName = 'صرف عهدة بدون مرفق'; fileName = 'صرف_عهدة_بدون_مرفق.xlsx';
        } else if (sectionNum === 2) {
            exportRows = rows.map(r => ({ 'كود المادة': r.material, 'الوصف': r.materialDesc, 'الكمية': r.qty, 'تاريخ الترحيل': formatAuditDate(r.postingDate), 'رقم المستند': r.materialDoc }));
            sheetName = 'تكهين بدون مرفق'; fileName = 'تكهين_بدون_مرفق.xlsx';
        } else if (sectionNum === 3) {
            exportRows = rows.map(r => ({ 'كود المادة': r.material, 'الوصف': r.materialDesc, 'الموظف': r.employee, 'الكمية المصروفة': r.issuedQty, 'الكمية المرتجعة': r.returnedQty, 'الكمية المتبقية كعهدة': r.outstandingQty, 'تاريخ آخر صرف': formatAuditDate(r.lastIssueDate) }));
            sheetName = 'عهد بدون مرتجع'; fileName = 'عهد_بدون_مرتجع.xlsx';
        } else if (sectionNum === 4) {
            exportRows = rows.map(r => ({ 'كود المادة': r.material, 'الوصف': r.materialDesc, 'الموظف': r.employee, 'الكمية غير المكهّنة': r.outstandingQty, 'حالة الصنف': r.valuationType, 'تاريخ الإرجاع': formatAuditDate(r.postingDate), 'رقم المستند': r.materialDoc }));
            sheetName = 'مرتجع تالف بدون تكهين'; fileName = 'مرتجع_تالف_بدون_تكهين.xlsx';
        } else {
            exportRows = rows.map(r => ({ 'كود المادة': r.material, 'الوصف': r.materialDesc, 'الموظف': r.employee, 'الكمية بدون دورة صيانة': r.outstandingQty, 'تاريخ الإرجاع': formatAuditDate(r.postingDate), 'رقم المستند': r.materialDoc }));
            sheetName = 'مرتجع UNREPAIRED بدون صيانة'; fileName = 'مرتجع_يحتاج_صيانة.xlsx';
        }
        let worksheet = XLSX.utils.json_to_sheet(exportRows);
        let workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
        XLSX.writeFile(workbook, fileName);
    }

    // ============ الوضع الليلي ============
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        let icon = document.getElementById('themeToggleIcon');
        let label = document.getElementById('themeToggleLabel');
        if (icon && label) {
            icon.textContent = theme === 'dark' ? '☀️' : '🌙';
            label.textContent = theme === 'dark' ? 'الوضع النهاري' : 'الوضع الليلي';
        }
    }
    function toggleTheme() {
        let current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        let next = current === 'dark' ? 'light' : 'dark';
        localStorage.setItem('appTheme', next);
        applyTheme(next);
    }
    applyTheme(localStorage.getItem('appTheme') === 'dark' ? 'dark' : 'light');

    // ============ التشغيل عند تحميل الصفحة ============
    window.onload = async function () {
        await migrateFromLocalStorageIfNeeded();
        let health = await checkStorageHealth();
        if (!health.ok) {
            let banner = document.createElement('div');
            banner.className = 'alert alert-danger m-3';
            banner.innerHTML = '⚠️ <b>تنبيه هام:</b> تخزين البيانات في هذا الجهاز مش شغال حاليًا، يعني أي بيانات هتضيف أو طلبات هتحفظها ممكن متتحفظش. السبب: ' + health.reason;
            document.body.insertBefore(banner, document.body.firstChild);
        }
        await loadMasterData();
        await loadArchive();
        await loadAuditLog();
    };