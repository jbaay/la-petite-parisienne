    // ==================== FIREBASE CONFIG ====================
    // ⚠️ SECURITE: Ces clés sont publiques (normal pour Firebase côté client).
    // IMPORTANT: Vérifiez vos Firestore Security Rules dans la console Firebase!
    // Elles doivent exiger l'authentification: allow read, write: if request.auth != null;
    firebase.initializeApp({apiKey:"AIzaSyDueowWpJEKAuoYKrsS0ddRelxuspIfhTA",authDomain:"la-petite-parisienne.firebaseapp.com",projectId:"la-petite-parisienne",storageBucket:"la-petite-parisienne.firebasestorage.app",messagingSenderId:"377979404609",appId:"1:377979404609:web:7b32a282f8201fdface1c0"});
    const auth = firebase.auth();
    const db = firebase.firestore();
    db.enablePersistence({synchronizeTabs:true}).catch(e=>{console.warn('Persistence:',e.code)});

    // ==================== UTILITIES: XSS PROTECTION ====================
    function esc(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    // ==================== UTILITIES: TOAST NOTIFICATIONS ====================
    function showToast(message, type='success', duration=3000) {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = 'toast ' + type;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => {
            toast.classList.add('hiding');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    // ==================== UTILITIES: CUSTOM CONFIRM ====================
    function showConfirm(title, message, icon, onConfirm, confirmText='Confirmar', confirmClass='btn-danger') {
        const modal = document.getElementById('confirmModal');
        modal.style.display = 'block';
        modal.innerHTML = `<div class="confirm-backdrop">
            <div class="confirm-box">
                <div class="confirm-icon">${icon}</div>
                <div class="confirm-title">${esc(title)}</div>
                <div class="confirm-msg">${esc(message)}</div>
                <div class="confirm-btns">
                    <button class="btn btn-secondary" onclick="closeConfirm()">Cancelar</button>
                    <button class="btn ${confirmClass}" id="confirmOkBtn">${confirmText}</button>
                </div>
            </div>
        </div>`;
        document.getElementById('confirmOkBtn').onclick = function() { closeConfirm(); onConfirm(); };
    }
    function closeConfirm() { document.getElementById('confirmModal').style.display = 'none'; document.getElementById('confirmModal').innerHTML = ''; }

    // ==================== UTILITIES: DEBOUNCE ====================
    function debounce(fn, delay=300) {
        let timer;
        return function(...args) { clearTimeout(timer); timer = setTimeout(() => fn.apply(this, args), delay); };
    }
    const debouncedCalculatePayments = debounce(calculatePayments, 250);

    let currentUser = null;
    let syncStatus = 'synced';
    let unsubEvents = null;
    let unsubExpenses = null;
    let unsubTemplates = null;
    let revenueChart = null;

    // ==================== DATA STORAGE ====================
    let appData = { events: [], expenses: [], settings: { defaultResicoRate: 2.5 } };
    let currentMonth = new Date().getMonth();
    let currentYear = new Date().getFullYear();
    let expenseMonth = new Date().getMonth();
    let expenseYear = new Date().getFullYear();
    let currentEventId = null;
    let currentFilter = 'all';
    let selectedServices = [];
    let editingEventId = null;
    let formData = { newEvent: {}, serviceForm: {} };
    let eventsPageSize = 20;
    let eventsDisplayed = 20;
    // New feature state
    let currentPayments = [];
    let currentPayMethod = 'efectivo';
    let formPhotos = [];
    let lineItems = [];
    let notifications = [];
    let appTemplates = JSON.parse(localStorage.getItem('lpp_templates') || '[]');
    // Drag & drop state
    let dragSrcIndex = null;
    let isOnline = navigator.onLine;

    // ==================== AUTH ====================
    auth.onAuthStateChanged(user => {
        currentUser = user;
        document.getElementById('loadingScreen').style.display = 'none';
        if (user) {
            document.getElementById('loginScreen').style.display = 'none';
            document.getElementById('appContainer').classList.add('visible');
            document.getElementById('headerUser').textContent = '👤 ' + user.email.split('@')[0];
            setupRealtimeListeners();
        } else {
            document.getElementById('loginScreen').style.display = 'flex';
            document.getElementById('appContainer').classList.remove('visible');
            if (unsubEvents) unsubEvents();
            if (unsubExpenses) unsubExpenses();
            if (unsubTemplates) unsubTemplates();
        }
    });

    async function login() {
        const email = document.getElementById('loginEmail').value;
        const password = document.getElementById('loginPassword').value;
        const errorEl = document.getElementById('loginError');
        if (!email || !password) { errorEl.textContent = 'Por favor ingresa email y contraseña'; errorEl.classList.add('show'); return; }
        try { await auth.signInWithEmailAndPassword(email, password); }
        catch (e) {
            let msg = 'Error de conexión';
            if (e.code === 'auth/invalid-email') msg = 'Email inválido';
            else if (e.code === 'auth/user-not-found') msg = 'Usuario no encontrado';
            else if (e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential') msg = 'Contraseña incorrecta';
            errorEl.textContent = msg; errorEl.classList.add('show');
        }
    }
    function logout() { showConfirm('Cerrar Sesión','¿Seguro que quieres salir?','👋',function(){auth.signOut();},'Salir','btn-danger'); }

    function updateSyncStatus(status) {
        syncStatus = status;
        const dot = document.getElementById('syncDot');
        const text = document.getElementById('syncText');
        dot.className = 'sync-dot';
        if (status === 'syncing') { dot.classList.add('syncing'); text.textContent = 'Sincronizando...'; }
        else if (status === 'error') { dot.classList.add('error'); text.textContent = 'Sin conexión'; }
        else { text.textContent = 'Guardado ☁️'; }
    }

    // ==================== REALTIME LISTENERS (offline-first) ====================
    function migrateEvent(ev) {
        if (!ev.payments) ev.payments = [];
        if (!ev.photos) ev.photos = [];
        if (!ev.lineItems) ev.lineItems = [];
        // Auto-calculate status from payments
        const paid = ev.payments.reduce((s,p)=>s+(p.amount||0),0);
        if(paid >= ev.totalPrice && ev.totalPrice > 0) ev.status = 'paid';
        else if(paid > 0) ev.status = 'partial';
        else if(ev.status === undefined) ev.status = 'pending';
        return ev;
    }

    function setupRealtimeListeners() {
        // Prevent duplicate listeners
        if (unsubEvents) { unsubEvents(); unsubEvents = null; }
        if (unsubExpenses) { unsubExpenses(); unsubExpenses = null; }
        if (unsubTemplates) { unsubTemplates(); unsubTemplates = null; }
        updateSyncStatus('syncing');
        // Events listener - update data always but debounce UI refresh
        unsubEvents = db.collection('dm_events').orderBy('eventDate','asc').onSnapshot({includeMetadataChanges:true}, snap => {
            const hasPending = snap.docs.some(d => d.metadata.hasPendingWrites);
            updateSyncStatus(hasPending ? 'syncing' : 'synced');
            // Build fresh list from Firestore (this is the source of truth)
            const freshEvents = snap.docs.map(d => migrateEvent({id:d.id,...d.data()}));
            // Keep any local_ events that haven't been synced yet (no Firestore doc yet)
            const firestoreIds = new Set(freshEvents.map(e => e.id));
            const pendingLocals = appData.events.filter(e => e.id.startsWith('local_') && !firestoreIds.has(e.id));
            appData.events = [...freshEvents, ...pendingLocals];
            localStorage.setItem('dulcesMomentosData', JSON.stringify(appData));
            computeNotifications();
            initializeApp();
            updateQuickStats();
        }, err => {
            updateSyncStatus('error');
            showToast('Erreur de connexion — mode hors ligne', 'error');
            const cached = localStorage.getItem('dulcesMomentosData');
            if (cached) appData = JSON.parse(cached);
            initializeApp();
            updateQuickStats();
        });
        // Expenses listener
        unsubExpenses = db.collection('dm_expenses').onSnapshot(snap => {
            appData.expenses = snap.docs.map(d => ({id:d.id,...d.data()}));
            localStorage.setItem('dulcesMomentosData', JSON.stringify(appData));
            refreshUI();
            updateQuickStats();
        }, err => {
            showToast('Erreur sync gastos — mode hors ligne', 'error');
        });
        // Templates listener (synced via Firebase)
        unsubTemplates = db.collection('dm_templates').onSnapshot(snap => {
            appTemplates = snap.docs.map(d => ({id:d.id,...d.data()}));
            localStorage.setItem('lpp_templates', JSON.stringify(appTemplates));
            renderTemplates();
        }, err => {
            // Fallback to localStorage
            const cached = localStorage.getItem('lpp_templates');
            if (cached) appTemplates = JSON.parse(cached);
        });
    }

    // Legacy save functions (still used for writes)
    async function saveEventToFirebase(event) {
        updateSyncStatus('syncing');
        try {
            const data = Object.assign({}, event);
            delete data.id;
            if (event.id && !event.id.startsWith('local_')) {
                await db.collection('dm_events').doc(event.id).set(data);
            } else {
                const oldId = event.id;
                const ref = await db.collection('dm_events').add(data);
                event.id = ref.id;
                const idx = appData.events.findIndex(e => e.id === oldId);
                if (idx !== -1) appData.events[idx].id = ref.id;
            }
            updateSyncStatus('synced');
        } catch(e) {
            updateSyncStatus('error');
            showToast('Erreur sauvegarde — données gardées localement', 'error');
        }
        localStorage.setItem('dulcesMomentosData', JSON.stringify(appData));
    }
    async function deleteEventFromFirebase(eventId) {
        updateSyncStatus('syncing');
        try {
            if (eventId && !eventId.startsWith('local_')) await db.collection('dm_events').doc(eventId).delete();
            updateSyncStatus('synced');
        } catch(e) {
            updateSyncStatus('error');
            showToast('Erreur suppression — réessayez', 'error');
        }
        localStorage.setItem('dulcesMomentosData', JSON.stringify(appData));
    }
    async function saveExpenseToFirebase(expense) {
        updateSyncStatus('syncing');
        try {
            const data = Object.assign({}, expense);
            delete data.id;
            if (expense.id && !expense.id.startsWith('local_')) { await db.collection('dm_expenses').doc(expense.id).set(data); }
            else {
                const oldId = expense.id;
                const ref = await db.collection('dm_expenses').add(data);
                expense.id = ref.id;
                const idx = appData.expenses.findIndex(e => e.id === oldId);
                if (idx !== -1) appData.expenses[idx].id = ref.id;
            }
            updateSyncStatus('synced');
        } catch(e) {
            updateSyncStatus('error');
            showToast('Erreur sauvegarde gasto — données gardées localement', 'error');
        }
        localStorage.setItem('dulcesMomentosData', JSON.stringify(appData));
    }
    async function deleteExpenseFromFirebase(expenseId) {
        updateSyncStatus('syncing');
        try {
            if (expenseId && !expenseId.startsWith('local_')) await db.collection('dm_expenses').doc(expenseId).delete();
            updateSyncStatus('synced');
        } catch(e) {
            updateSyncStatus('error');
            showToast('Erreur suppression gasto', 'error');
        }
        localStorage.setItem('dulcesMomentosData', JSON.stringify(appData));
    }
    // Template Firebase save/delete
    async function saveTemplateToFirebase(template) {
        try {
            const data = Object.assign({}, template);
            delete data.id;
            if (template.id && !template.id.startsWith('tpl_')) {
                await db.collection('dm_templates').doc(template.id).set(data);
            } else {
                const oldId = template.id;
                const ref = await db.collection('dm_templates').add(data);
                template.id = ref.id;
                const idx = appTemplates.findIndex(t => t.id === oldId);
                if (idx !== -1) appTemplates[idx].id = ref.id;
            }
        } catch(e) { showToast('Erreur sauvegarde template', 'error'); }
        localStorage.setItem('lpp_templates', JSON.stringify(appTemplates));
    }
    async function deleteTemplateFromFirebase(templateId) {
        try {
            if (templateId && !templateId.startsWith('tpl_')) await db.collection('dm_templates').doc(templateId).delete();
        } catch(e) { showToast('Erreur suppression template', 'error'); }
        localStorage.setItem('lpp_templates', JSON.stringify(appTemplates));
    }

    function loadData() { const s=localStorage.getItem('dulcesMomentosData'); if(s) appData=JSON.parse(s); }
    function saveData() { localStorage.setItem('dulcesMomentosData', JSON.stringify(appData)); }

    // ==================== ONLINE/OFFLINE ====================
    window.addEventListener('online', ()=>{ isOnline=true; document.getElementById('offlineBanner').classList.remove('visible'); });
    window.addEventListener('offline', ()=>{ isOnline=false; document.getElementById('offlineBanner').classList.add('visible'); });

    // ==================== INITIALIZATION ====================
    let _appInitialized = false;
    let _refreshTimer = null;

    function initializeAppOnce() {
        if (_appInitialized) return;
        _appInitialized = true;
        const today = new Date().toISOString().split('T')[0];
        const ed = document.getElementById('eventDate');
        if (ed && !ed.value) ed.value = today;
        const pd = document.getElementById('payDate');
        if (pd && !pd.value) pd.value = today;
        const venueEl = document.getElementById('eventVenue');
        if (venueEl) venueEl.addEventListener('change', function() { document.getElementById('otherVenueGroup').style.display = this.value==='Otro'?'block':'none'; });
        updateMonthDisplay();
        updateExpenseMonthDisplay();
        // Update PDF template status
        const ts=document.getElementById('templateStatus');
        const mb=document.getElementById('mainTemplateBtn');
        if(pdfTemplateImg){
            if(ts) ts.textContent='✅ Template cargado';
            if(mb) mb.innerHTML='🖼️ ✅ Template PDF cargado (cambiar)';
        } else {
            if(ts) ts.textContent='⚠️ Carga tu imagen de cotización para generar PDFs bonitos';
        }
    }

    // Called on each snapshot - debounced to avoid rapid re-renders
    function refreshUI() {
        if (_refreshTimer) clearTimeout(_refreshTimer);
        _refreshTimer = setTimeout(function() {
            _refreshTimer = null;
            renderEvents();
            renderExpenses();
            renderTemplates();
            // If dashboard is visible, refresh it too
            const dashEl = document.getElementById('dashboard');
            if (dashEl && dashEl.classList.contains('active')) { updateDashboard(); renderChart(); }
        }, 100);
    }

    function initializeApp() {
        initializeAppOnce();
        refreshUI();
    }

    // ==================== NAVIGATION ====================
    function showSection(sectionId) {
        saveFormData();
        document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
        document.getElementById(sectionId).classList.add('active');
        const backBtn = document.getElementById('backToMenuBtn');
        backBtn.style.display = sectionId==='mainMenu' ? 'none' : 'flex';
        if (sectionId==='newEvent' && !editingEventId) restoreFormData();
        if (sectionId==='events') renderEvents();
        else if (sectionId==='dashboard') { updateDashboard(); setTimeout(renderChart,200); }
        else if (sectionId==='expenses') renderExpenses();
        else if (sectionId==='templates') renderTemplates();
        computeNotifications();
        window.scrollTo(0,0);
    }
    function goToMainMenu() { showSection('mainMenu'); updateQuickStats(); }

    // ==================== FORM DATA PRESERVATION ====================
    function saveFormData() {
        const s = document.getElementById('newEvent');
        if (s && s.classList.contains('active')) {
            formData.newEvent = {
                clientName: document.getElementById('clientName').value,
                clientPhone: document.getElementById('clientPhone').value,
                eventDate: document.getElementById('eventDate').value,
                eventVenue: document.getElementById('eventVenue').value,
                otherVenue: document.getElementById('otherVenue').value,
                guestCount: document.getElementById('guestCount').value,
                totalPrice: document.getElementById('totalPrice').value,
                hasPlanner: document.getElementById('hasPlanner').checked,
                plannerName: document.getElementById('plannerName').value,
                commissionRate: document.getElementById('commissionRate').value,
                eventNotes: document.getElementById('eventNotes').value,
                selectedServices: [...selectedServices],
                payments: [...currentPayments],
                photos: [...formPhotos],
                lineItems: [...lineItems]
            };
        }
    }
    function restoreFormData() {
        if (formData.newEvent && Object.keys(formData.newEvent).length > 0) {
            const d = formData.newEvent;
            document.getElementById('clientName').value = d.clientName||'';
            document.getElementById('clientPhone').value = d.clientPhone||'';
            document.getElementById('eventDate').value = d.eventDate||'';
            document.getElementById('eventVenue').value = d.eventVenue||'';
            document.getElementById('otherVenue').value = d.otherVenue||'';
            document.getElementById('guestCount').value = d.guestCount||'';
            document.getElementById('totalPrice').value = d.totalPrice||'';
            document.getElementById('hasPlanner').checked = d.hasPlanner||false;
            document.getElementById('plannerName').value = d.plannerName||'';
            document.getElementById('commissionRate').value = d.commissionRate||'10';
            document.getElementById('eventNotes').value = d.eventNotes||'';
            selectedServices = d.selectedServices||[];
            currentPayments = d.payments||[];
            formPhotos = d.photos||[];
            lineItems = d.lineItems||[];
            document.querySelectorAll('.service-card').forEach(c => {
                c.classList.toggle('selected', selectedServices.includes(c.dataset.service));
            });
            togglePlannerFields(); calculatePayments();
            if (d.eventVenue==='Otro') document.getElementById('otherVenueGroup').style.display='block';
            renderFormPayments(); renderFormPhotos(); renderLineItems();
        }
    }
    function clearFormData() {
        formData.newEvent = {};
        selectedServices = []; editingEventId = null;
        currentPayments = []; formPhotos = []; lineItems = [];
        const ft = document.getElementById('formTitle'); if(ft) ft.textContent = '✨ Nuevo Evento';
        document.getElementById('clientName').value = '';
        document.getElementById('clientPhone').value = '';
        document.getElementById('eventDate').value = new Date().toISOString().split('T')[0];
        document.getElementById('eventVenue').value = '';
        document.getElementById('otherVenue').value = '';
        document.getElementById('guestCount').value = '';
        document.getElementById('totalPrice').value = '';
        document.getElementById('hasPlanner').checked = false;
        document.getElementById('plannerName').value = '';
        document.getElementById('commissionRate').value = '10';
        document.getElementById('eventNotes').value = '';
        document.querySelectorAll('.service-card').forEach(c => c.classList.remove('selected'));
        document.getElementById('plannerFields').style.display = 'none';
        document.getElementById('commissionRow').style.display = 'none';
        document.getElementById('otherVenueGroup').style.display = 'none';
        const pd = document.getElementById('payDate'); if(pd) pd.value = new Date().toISOString().split('T')[0];
        calculatePayments(); renderFormPayments(); renderFormPhotos(); renderLineItems();
    }

    // ==================== SERVICES ====================
    function toggleService(el) { const s=el.dataset.service; el.classList.toggle('selected'); if(el.classList.contains('selected')){if(!selectedServices.includes(s))selectedServices.push(s);}else{selectedServices=selectedServices.filter(x=>x!==s);} updateServiceDetails(); }
    function updateServiceDetails() {
        const c=document.getElementById('serviceDetails'); if(selectedServices.length===0){c.innerHTML='';return;}
        const nm={pastel:'🎂 Pastel',mesa_dulces:'🍬 Mesa de Dulces',postres:'🧁 Postres',quesos:'🧀 Mesa de Quesos',bebidas:'🥂 Bebidas',otro:'📦 Otro'};
        let h='<div style="margin-top:15px;">';
        selectedServices.forEach(s=>{ h+=`<div class="form-group"><label class="form-label">${nm[s]} - Detalles</label><input type="text" class="form-input" id="service_${s}_details" placeholder="Descripción específica..." value="${formData.newEvent['service_'+s+'_details']||''}"></div>`; });
        h+='</div>'; c.innerHTML=h;
    }
    function showServiceForm(st) {
        const nm={pastel:{icon:'🎂',name:'Pastel de Bodas'},mesa_dulces:{icon:'🍬',name:'Mesa de Dulces'},postres:{icon:'🧁',name:'Postres'},quesos:{icon:'🧀',name:'Mesa de Quesos'}};
        const s=nm[st];
        document.getElementById('serviceFormContent').innerHTML=`<div class="card"><div class="card-header"><h3 class="card-title">${s.icon} ${s.name}</h3></div><p style="color:var(--text-medium);margin-bottom:20px;">¿Quieres crear un nuevo evento con este servicio?</p><button class="btn btn-primary" onclick="startEventWithService('${st}')">✨ Crear Evento con ${s.name}</button><button class="btn btn-secondary" style="margin-top:10px;" onclick="goToMainMenu()">← Volver al Menú</button></div>`;
        showSection('serviceForm');
    }
    function startEventWithService(st) { selectedServices=[st]; formData.newEvent={selectedServices:[st]}; showSection('newEvent'); document.querySelectorAll('.service-card').forEach(c=>{c.classList.toggle('selected',c.dataset.service===st);}); updateServiceDetails(); }

    // ==================== PAYMENTS & CALCULATIONS ====================
    function togglePlannerFields() {
        const hp=document.getElementById('hasPlanner').checked;
        document.getElementById('plannerFields').style.display=hp?'block':'none';
        document.getElementById('commissionRow').style.display=hp?'flex':'none';
        calculatePayments();
    }
    function calculatePayments() {
        const tp=parseFloat(document.getElementById('totalPrice').value)||0;
        const hp=document.getElementById('hasPlanner').checked;
        const cr=parseFloat(document.getElementById('commissionRate').value)||10;
        const commission=hp?tp*(cr/100):0;
        document.getElementById('netAmount').textContent=formatCurrency(tp);
        document.getElementById('commissionAmount').textContent=formatCurrency(commission);
        document.getElementById('resicoGross').textContent=formatCurrency(tp);
        document.getElementById('resicoCommission').textContent=formatCurrency(commission);
        document.getElementById('resicoNet').textContent=formatCurrency(tp);
        // Payment summary
        const paid=currentPayments.reduce((s,p)=>s+(p.amount||0),0);
        const el1=document.getElementById('totalPaidDisplay'); if(el1) el1.textContent=formatCurrency(paid);
        const el2=document.getElementById('remainingDisplay'); if(el2) el2.textContent=formatCurrency(Math.max(0,tp-paid));
    }
    function formatCurrency(a) { return '$'+a.toLocaleString('es-MX',{minimumFractionDigits:0,maximumFractionDigits:0}); }

    // ==================== MULTI-PAYMENT ====================
    function setPayMethod(m) { currentPayMethod=m; document.querySelectorAll('#payMethodBtns .pay-method-btn').forEach(b=>{b.classList.toggle('active',b.textContent.toLowerCase().includes(m.substring(0,4)));}); }
    function addPaymentToForm() {
        const a=parseFloat(document.getElementById('payAmount').value)||0;
        const d=document.getElementById('payDate').value;
        const n=document.getElementById('payNote').value;
        if(a<=0){showToast('Ingresa un monto válido','warning');return;}
        currentPayments.push({amount:a,date:d||new Date().toISOString().split('T')[0],method:currentPayMethod,note:n});
        document.getElementById('payAmount').value='';
        document.getElementById('payNote').value='';
        renderFormPayments(); calculatePayments();
    }
    function removePayment(i) { currentPayments.splice(i,1); renderFormPayments(); calculatePayments(); }
    function renderFormPayments() {
        const c=document.getElementById('paymentsList'); if(!c) return;
        const mi={'efectivo':'💵','transferencia':'🏦','tarjeta':'💳'};
        const total=currentPayments.reduce((s,p)=>s+(p.amount||0),0);
        if(currentPayments.length===0){c.innerHTML='<p style="color:var(--text-light);text-align:center;padding:8px;">Sin pagos registrados</p>';return;}
        c.innerHTML=currentPayments.map((p,i)=>`<div class="payment-history-item"><div><strong>${mi[p.method]||'💵'} ${formatCurrency(p.amount)}</strong><br><small style="color:var(--text-medium);">${formatDate(p.date)}${p.note?' - '+esc(p.note):''}</small></div><button class="delete-btn" onclick="removePayment(${i})" style="width:28px;height:28px;font-size:0.9rem;">×</button></div>`).join('')+`<div style="text-align:right;font-weight:700;padding-top:8px;border-top:2px solid var(--border);margin-top:4px;">Total pagado: ${formatCurrency(total)}</div>`;
    }

    // ==================== PHOTOS ====================
    function compressImage(file, cb) {
        const r=new FileReader(); r.onload=function(e){
            const img=new Image(); img.onload=function(){
                const max=800; let w=img.width,h=img.height;
                if(w>max||h>max){if(w>h){h=h*(max/w);w=max;}else{w=w*(max/h);h=max;}}
                const canvas=document.createElement('canvas'); canvas.width=w; canvas.height=h;
                canvas.getContext('2d').drawImage(img,0,0,w,h);
                let data=canvas.toDataURL('image/jpeg',0.6);
                if(data.length>200000) data=canvas.toDataURL('image/jpeg',0.4);
                cb(data);
            }; img.src=e.target.result;
        }; r.readAsDataURL(file);
    }
    function addFormPhoto() {
        if(formPhotos.length>=5){showToast('Máximo 5 fotos','warning');return;}
        const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*';
        inp.onchange=function(){if(inp.files[0])compressImage(inp.files[0],data=>{formPhotos.push(data);renderFormPhotos();});};
        inp.click();
    }
    function removeFormPhoto(i) { formPhotos.splice(i,1); renderFormPhotos(); }
    function renderFormPhotos() {
        const c=document.getElementById('formPhotos'); if(!c)return;
        const pc=document.getElementById('photoCount'); if(pc) pc.textContent=formPhotos.length+'/5';
        c.innerHTML=formPhotos.map((p,i)=>`<div style="position:relative;display:inline-block;"><img src="${p}" class="photo-thumb" onclick="viewPhoto(${i},'form')"><button onclick="removeFormPhoto(${i})" style="position:absolute;top:-6px;right:-6px;background:var(--danger);color:white;border:none;width:20px;height:20px;border-radius:50%;font-size:0.7rem;cursor:pointer;">×</button></div>`).join('')+(formPhotos.length<5?'<div class="photo-add-btn" onclick="addFormPhoto()">+</div>':'');
    }
    function viewPhoto(i,src) {
        const photos = src==='form' ? formPhotos : (appData.events.find(e=>e.id===currentEventId)||{}).photos||[];
        if(!photos[i])return;
        document.getElementById('photoFullModal').style.display='block';
        document.getElementById('photoFullModal').innerHTML=`<div class="photo-full-modal" onclick="closePhotoModal()"><img src="${photos[i]}" style="max-width:95%;max-height:90%;object-fit:contain;border-radius:8px;"><div style="position:absolute;top:20px;right:20px;color:white;font-size:2rem;cursor:pointer;">✕</div></div>`;
    }
    function closePhotoModal() { document.getElementById('photoFullModal').style.display='none'; document.getElementById('photoFullModal').innerHTML=''; }

    // ==================== CATALOG / PAQUETES ====================
    const CATALOG = {
        basico: {
            name: 'Paquete Basico', icon: '🍬',
            desc: 'Snacks únicamente',
            tiers: [
                {guests:100, price:75, note:'8 variedades de snack'},
                {guests:150, price:70, note:'10 variedades de snack'},
                {guests:200, price:60, note:'12 variedades de snack'}
            ],
            includes: 'Incluye decoraciones de flores, bases con diseño personalizado para montaje, bolsas personalizadas. Incluye transporte montaje y desmontaje. No incluye mesa.'
        },
        premium: {
            name: 'Paquete Premium', icon: '🍬🧁',
            desc: 'Snacks + Postres',
            tiers: [
                {guests:100, price:95, note:'6 variedades de snack + 4 postres'},
                {guests:150, price:85, note:'8 variedades de snack + 5 postres'},
                {guests:200, price:80, note:'10 variedades de snack + 6 postres'}
            ],
            includes: 'Incluye decoraciones de flores, bases con diseño personalizado para montaje, bolsas personalizadas. Incluye transporte montaje y desmontaje. No incluye mesa.'
        },
        plus: {
            name: 'Paquete Plus', icon: '🍬🧁🧀',
            desc: 'Snacks + Postres + Quesos',
            tiers: [
                {guests:100, price:150, note:'6 snack + 4 postres + 4 quesos'},
                {guests:150, price:120, note:'8 snack + 5 postres + 5 quesos'},
                {guests:200, price:100, note:'10 snack + 6 postres + 6 quesos'}
            ],
            includes: 'Incluye decoraciones de flores, bases con diseño personalizado para montaje, bolsas personalizadas. Incluye transporte montaje y desmontaje. No incluye mesa.'
        },
        fromage: {
            name: 'Fromage & Friends', icon: '🧀',
            desc: 'Quesos y charcutería - Muro gourmet',
            tiers: [
                {guests:100, price:0, fixed:11000, note:'Muro de quesos y charcutería'},
                {guests:150, price:0, fixed:15000, note:'Muro de quesos y charcutería'},
                {guests:200, price:0, fixed:18000, note:'Muro de quesos y charcutería'}
            ],
            includes: 'Sabores que se sirven en vertical.'
        },
        sugar: {
            name: 'Sugar Avenue', icon: '🍭',
            desc: 'Dulces y botanas - Muro gourmet',
            tiers: [
                {guests:100, price:0, fixed:9000, note:'Muro de dulces y botanas'},
                {guests:150, price:0, fixed:12000, note:'Muro de dulces y botanas'},
                {guests:200, price:0, fixed:15000, note:'Muro de dulces y botanas'}
            ],
            includes: 'Sabores que se sirven en vertical.'
        },
        fiesta: {
            name: 'The Fiesta Wall', icon: '🎉',
            desc: 'Quesos y dulces - Muro gourmet',
            tiers: [
                {guests:100, price:0, fixed:12000, note:'Muro de quesos y dulces'},
                {guests:150, price:0, fixed:16000, note:'Muro de quesos y dulces'},
                {guests:200, price:0, fixed:19000, note:'Muro de quesos y dulces'}
            ],
            includes: 'Sabores que se sirven en vertical.'
        }
    };

    let selectedCatalogTier = null;

    function showCatalogOptions() {
        const sel=document.getElementById('catalogSelect').value;
        const optDiv=document.getElementById('catalogOptions');
        const prevDiv=document.getElementById('catalogPreview');
        if(!sel){optDiv.style.display='none';selectedCatalogTier=null;return;}
        optDiv.style.display='block';
        prevDiv.style.display='none';
        selectedCatalogTier=null;
        const pkg=CATALOG[sel]; if(!pkg)return;
        const btnsDiv=document.getElementById('catalogGuestBtns');
        btnsDiv.innerHTML=pkg.tiers.map((t,i)=>`<button class="pay-method-btn" onclick="selectCatalogTier('${sel}',${i})" id="tierBtn${i}" style="flex:1;padding:12px;text-align:center;"><div style="font-weight:700;font-size:1.1rem;">${t.guests}</div><div style="font-size:0.8rem;">invitados</div><div style="font-weight:700;color:var(--primary-dark);margin-top:4px;">${t.fixed?formatCurrency(t.fixed):'$'+t.price+'/pax'}</div></button>`).join('');
    }

    function selectCatalogTier(pkgKey,tierIdx) {
        const pkg=CATALOG[pkgKey]; if(!pkg)return;
        selectedCatalogTier={pkg:pkgKey,tier:tierIdx};
        // Highlight selected button
        document.querySelectorAll('#catalogGuestBtns .pay-method-btn').forEach((b,i)=>{b.classList.toggle('active',i===tierIdx);});
        // Show preview
        const t=pkg.tiers[tierIdx];
        const total=t.fixed||(t.price*t.guests);
        const prevDiv=document.getElementById('catalogPreview');
        prevDiv.style.display='block';
        prevDiv.innerHTML=`<div style="font-weight:700;font-size:1.05rem;margin-bottom:6px;">${pkg.icon} ${pkg.name}</div><div style="font-size:0.9rem;color:var(--text-medium);margin-bottom:4px;">${t.note}</div><div style="font-size:0.85rem;color:var(--text-medium);margin-bottom:8px;">${pkg.includes}</div><div style="font-weight:700;font-size:1.2rem;color:var(--primary-dark);">Total: ${formatCurrency(total)}</div>`;
    }

    function applyCatalogToLines() {
        if(!selectedCatalogTier){showToast('Selecciona un número de invitados primero','warning');return;}
        const pkgKey=selectedCatalogTier.pkg;
        const tierIdx=selectedCatalogTier.tier;
        const pkg=CATALOG[pkgKey]; if(!pkg)return;
        const t=pkg.tiers[tierIdx];
        const isFixed=!!t.fixed;
        const total=isFixed?t.fixed:(t.price*t.guests);

        // Add as line item(s)
        lineItems.push({
            description: pkg.name + ' ' + t.guests + 'pers',
            unitPrice: isFixed ? total : t.price,
            quantity: isFixed ? 1 : t.guests,
            note: t.note
        });
        // Add transport line
        lineItems.push({
            description: 'Transporte montaje y desmontaje',
            unitPrice: 0,
            quantity: 1,
            note: ''
        });
        renderLineItems();
        // Also set guest count
        document.getElementById('guestCount').value = t.guests;
        // Reset catalog selector
        selectedCatalogTier=null;
        document.getElementById('catalogSelect').value='';
        document.getElementById('catalogOptions').style.display='none';
    }

    // ==================== LINE ITEMS ====================
    function addLineItem() {
        lineItems.push({description:'',unitPrice:0,quantity:1,note:''});
        renderLineItems();
    }
    function removeLineItem(i) { lineItems.splice(i,1); recalcLineItems(); renderLineItems(); }
    function updateLineItem(i,field,val) {
        if(field==='unitPrice'||field==='quantity') lineItems[i][field]=parseFloat(val)||0;
        else lineItems[i][field]=val;
        recalcLineItems();
    }
    function recalcLineItems() {
        if(lineItems.length===0) return;
        const total=lineItems.reduce((s,li)=>s+(li.unitPrice||0)*(li.quantity||1),0);
        const el=document.getElementById('lineItemsTotal'); if(el) el.textContent=formatCurrency(total);
        // Auto-fill totalPrice if line items exist
        if(total>0){
            document.getElementById('totalPrice').value=total;
            calculatePayments();
        }
    }
    function renderLineItems() {
        const c=document.getElementById('lineItemsList'); if(!c) return;
        if(lineItems.length===0){c.innerHTML='<p style="color:var(--text-light);text-align:center;padding:12px;">Sin líneas — agrega una descripción con precio y cantidad</p>';document.getElementById('lineItemsTotal').textContent='$0';return;}
        c.innerHTML=lineItems.map((li,i)=>{
            const sub=(li.unitPrice||0)*(li.quantity||1);
            return `<div class="line-item" draggable="true" data-idx="${i}" ondragstart="onLineDragStart(event,${i})" ondragover="onLineDragOver(event)" ondragenter="onLineDragEnter(event)" ondragleave="onLineDragLeave(event)" ondrop="onLineDrop(event,${i})" ondragend="onLineDragEnd(event)"><div class="line-item-row"><span class="drag-handle">⠿</span><input type="text" class="form-input line-item-desc" placeholder="Descripción" value="${esc(li.description||'')}" onchange="updateLineItem(${i},'description',this.value)"><input type="number" class="form-input line-item-price" placeholder="Precio" value="${li.unitPrice||''}" oninput="updateLineItem(${i},'unitPrice',this.value)"><input type="number" class="form-input line-item-qty" placeholder="Qtd" value="${li.quantity||1}" oninput="updateLineItem(${i},'quantity',this.value)"><div class="line-item-subtotal">${formatCurrency(sub)}</div><button class="delete-btn" onclick="removeLineItem(${i})" style="width:28px;height:28px;font-size:0.9rem;flex-shrink:0;">×</button></div>${li.note||i===lineItems.length-1?`<input type="text" class="form-input line-item-note" placeholder="Detalle (ej: sabor, diseño...)" value="${esc(li.note||'')}" onchange="updateLineItem(${i},'note',this.value)">`:''}</div>`;
        }).join('');
        recalcLineItems();
    }
    // Drag & Drop for line items
    function onLineDragStart(e,i) { dragSrcIndex=i; e.currentTarget.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; }
    function onLineDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect='move'; }
    function onLineDragEnter(e) { e.preventDefault(); const el=e.currentTarget.closest('.line-item'); if(el) el.classList.add('drag-over'); }
    function onLineDragLeave(e) { const el=e.currentTarget.closest('.line-item'); if(el) el.classList.remove('drag-over'); }
    function onLineDrop(e,targetIdx) { e.preventDefault(); e.currentTarget.classList.remove('drag-over'); if(dragSrcIndex===null||dragSrcIndex===targetIdx)return; const item=lineItems.splice(dragSrcIndex,1)[0]; lineItems.splice(targetIdx,0,item); dragSrcIndex=null; renderLineItems(); }
    function onLineDragEnd(e) { e.currentTarget.classList.remove('dragging'); document.querySelectorAll('.line-item').forEach(el=>el.classList.remove('drag-over')); dragSrcIndex=null; }

    // ==================== EVENTS CRUD ====================
    // Auto-calculate status from payments
    function calcStatus(payments, totalPrice) {
        const paid=(payments||[]).reduce((s,p)=>s+(p.amount||0),0);
        if(paid>=totalPrice && totalPrice>0) return 'paid';
        if(paid>0) return 'partial';
        return 'pending';
    }

    function saveEvent() {
        const clientName=document.getElementById('clientName').value.trim();
        const clientPhone=document.getElementById('clientPhone').value.trim();
        const eventDate=document.getElementById('eventDate').value;
        const totalPrice=parseFloat(document.getElementById('totalPrice').value)||0;
        if(!clientName||!eventDate||totalPrice<=0){showToast('Completa: Nombre, Fecha y Precio','warning');return;}
        const hasPlanner=document.getElementById('hasPlanner').checked;
        const commissionRate=parseFloat(document.getElementById('commissionRate').value)||10;
        let venue=document.getElementById('eventVenue').value;
        if(venue==='Otro') venue=document.getElementById('otherVenue').value||'Otro';
        const serviceDetails={};
        selectedServices.forEach(s=>{const d=document.getElementById('service_'+s+'_details');if(d)serviceDetails[s]=d.value;});
        const commission=hasPlanner?totalPrice*(commissionRate/100):0;
        const status=calcStatus(currentPayments, totalPrice);

        if(editingEventId){
            const idx=appData.events.findIndex(e=>e.id===editingEventId);
            if(idx!==-1){
                const ex=appData.events[idx];
                const upd={...ex,clientName,clientPhone,eventDate,venue,guestCount:parseInt(document.getElementById('guestCount').value)||0,services:[...selectedServices],serviceDetails,totalPrice,netAmount:totalPrice,hasPlanner,plannerName:hasPlanner?document.getElementById('plannerName').value:'',commissionRate:hasPlanner?commissionRate:0,commission,notes:document.getElementById('eventNotes').value,payments:[...currentPayments],photos:[...formPhotos],lineItems:[...lineItems],status,updatedAt:new Date().toISOString()};
                appData.events[idx]=upd; saveData(); saveEventToFirebase(upd);
                editingEventId=null; clearFormData();
                showToast('Evento actualizado!','success'); showEventDetail(upd.id); return;
            }
        }
        const event={id:'local_'+Date.now(),clientName,clientPhone,eventDate,venue,guestCount:parseInt(document.getElementById('guestCount').value)||0,services:[...selectedServices],serviceDetails,totalPrice,netAmount:totalPrice,hasPlanner,plannerName:hasPlanner?document.getElementById('plannerName').value:'',commissionRate:hasPlanner?commissionRate:0,commission,commissionPaid:false,notes:document.getElementById('eventNotes').value,status,payments:[...currentPayments],photos:[...formPhotos],lineItems:[...lineItems],createdAt:new Date().toISOString()};
        appData.events.push(event); saveData(); saveEventToFirebase(event);
        clearFormData(); showToast('Evento guardado!','success'); goToMainMenu();
    }

    function renderEvents() {
        const c=document.getElementById('eventsList'); if(!c)return;
        let evs=[...appData.events];
        evs.sort((a,b)=>new Date(a.eventDate)-new Date(b.eventDate));
        // Only filter events (not global search), search field now handled by globalSearch
        const q=(document.getElementById('eventSearch')||{}).value||'';
        if(q.trim()){const ql=q.toLowerCase();evs=evs.filter(e=>(e.clientName||'').toLowerCase().includes(ql)||(e.venue||'').toLowerCase().includes(ql)||(e.plannerName||'').toLowerCase().includes(ql));}
        if(currentFilter!=='all') evs=evs.filter(e=>e.status===currentFilter);
        if(evs.length===0){c.innerHTML='<div style="text-align:center;padding:40px;color:var(--text-medium);"><div style="font-size:3rem;margin-bottom:15px;">📭</div><p>No hay eventos'+(currentFilter!=='all'?' con este filtro':'')+'</p></div>';return;}
        // Pagination: show only eventsDisplayed
        const total=evs.length;
        const shown=evs.slice(0,eventsDisplayed);
        c.innerHTML=shown.map(ev=>{
            const sb={pending:{c:'badge-pending',t:'Pendiente'},partial:{c:'badge-partial',t:'Parcial'},paid:{c:'badge-paid',t:'Pagado'}}[ev.status]||{c:'badge-pending',t:'Pendiente'};
            const si=(ev.services||[]).map(s=>({pastel:'🎂',mesa_dulces:'🍬',postres:'🧁',quesos:'🧀',bebidas:'🥂',otro:'📦'}[s]||'📦')).join('');
            const pc=(ev.photos||[]).length;
            return `<div class="event-item" onclick="showEventDetail('${esc(ev.id)}')"><div class="event-icon">${si||'🎂'}</div><div class="event-details"><div class="event-name">${esc(ev.clientName)}${pc?' 📷':''}</div><div class="event-date">${formatDate(ev.eventDate)} • ${esc(ev.venue||'Sin lugar')}</div></div><div class="event-amount"><div class="event-total">${formatCurrency(ev.totalPrice)}</div><div class="event-status"><span class="card-badge ${sb.c}">${sb.t}</span></div></div></div>`;
        }).join('');
        // Show "load more" if there are more events
        if(total>eventsDisplayed){
            c.innerHTML+=`<button class="load-more-btn" onclick="loadMoreEvents()">Cargar más (${eventsDisplayed}/${total}) ↓</button>`;
        }
    }
    function loadMoreEvents() { eventsDisplayed+=eventsPageSize; renderEvents(); }

    function filterEvents(f,btn) { currentFilter=f; eventsDisplayed=eventsPageSize; document.querySelectorAll('.tabs .tab').forEach(t=>t.classList.remove('active')); btn.classList.add('active'); renderEvents(); }

    // ==================== GLOBAL SEARCH ====================
    const debouncedGlobalSearch = debounce(_doGlobalSearch, 250);
    function globalSearch() { debouncedGlobalSearch(); }
    function _doGlobalSearch() {
        const q=(document.getElementById('eventSearch')||{}).value||'';
        const gsDiv=document.getElementById('globalSearchResults');
        const normalDiv=document.getElementById('eventsNormalView');
        if(!q.trim()) { gsDiv.style.display='none'; normalDiv.style.display='block'; renderEvents(); return; }
        gsDiv.style.display='block'; normalDiv.style.display='none';
        const ql=q.toLowerCase();
        // Search events
        const matchEvents=appData.events.filter(e=>(e.clientName||'').toLowerCase().includes(ql)||(e.venue||'').toLowerCase().includes(ql)||(e.plannerName||'').toLowerCase().includes(ql)||(e.notes||'').toLowerCase().includes(ql));
        // Search expenses
        const matchExpenses=appData.expenses.filter(e=>(e.description||'').toLowerCase().includes(ql)||(e.category||'').toLowerCase().includes(ql));
        // Search templates
        const matchTemplates=appTemplates.filter(t=>(t.name||'').toLowerCase().includes(ql));
        let html='';
        if(matchEvents.length>0){
            html+=`<div class="search-category">📋 Eventos (${matchEvents.length})</div>`;
            matchEvents.slice(0,10).forEach(ev=>{
                const sb={pending:{c:'badge-pending',t:'Pendiente'},partial:{c:'badge-partial',t:'Parcial'},paid:{c:'badge-paid',t:'Pagado'}}[ev.status]||{c:'badge-pending',t:'Pendiente'};
                html+=`<div class="event-item" onclick="showEventDetail('${esc(ev.id)}')"><div class="event-icon">📋</div><div class="event-details"><div class="event-name">${esc(ev.clientName)}</div><div class="event-date">${formatDate(ev.eventDate)} • ${esc(ev.venue||'')}</div></div><div class="event-amount"><div class="event-total">${formatCurrency(ev.totalPrice)}</div><span class="card-badge ${sb.c}">${sb.t}</span></div></div>`;
            });
        }
        if(matchExpenses.length>0){
            const ci={ingredientes:'🥚',transporte:'🚗',equipo:'🔧',marketing:'📣',otro:'📦'};
            html+=`<div class="search-category">💸 Gastos (${matchExpenses.length})</div>`;
            matchExpenses.slice(0,10).forEach(e=>{
                html+=`<div class="event-item" onclick="showSection('expenses')"><div class="event-icon">${ci[e.category]||'📦'}</div><div class="event-details"><div class="event-name">${esc(e.description)}</div></div><div class="event-amount"><div class="event-total" style="color:var(--danger);">${formatCurrency(e.amount)}</div></div></div>`;
            });
        }
        if(matchTemplates.length>0){
            html+=`<div class="search-category">📑 Templates (${matchTemplates.length})</div>`;
            matchTemplates.forEach(t=>{
                html+=`<div class="event-item" onclick="applyTemplate('${esc(t.id)}')"><div class="event-icon">📑</div><div class="event-details"><div class="event-name">${esc(t.name)}</div></div><div class="event-amount"><div class="event-total">${formatCurrency(t.totalPrice||0)}</div></div></div>`;
            });
        }
        if(!html) html='<div style="text-align:center;padding:30px;color:var(--text-medium);">Sin resultados para "'+esc(q)+'"</div>';
        gsDiv.innerHTML=html;
    }

    function showEventDetail(eventId) {
        currentEventId=eventId;
        const ev=appData.events.find(e=>e.id===eventId); if(!ev)return;
        const c=document.getElementById('eventDetailContent');
        const nm={pastel:'🎂 Pastel',mesa_dulces:'🍬 Mesa de Dulces',postres:'🧁 Postres',quesos:'🧀 Mesa de Quesos',bebidas:'🥂 Bebidas',otro:'📦 Otro'};
        const svcH=(ev.services||[]).map(s=>`<div style="background:var(--primary-light);padding:8px 12px;border-radius:8px;margin:4px;">${nm[s]||esc(s)}${ev.serviceDetails&&ev.serviceDetails[s]?'<br><small style="color:var(--text-medium);">'+esc(ev.serviceDetails[s])+'</small>':''}</div>`).join('');
        const mi={'efectivo':'💵','transferencia':'🏦','tarjeta':'💳'};
        const payH=(ev.payments||[]).map(p=>`<div class="payment-history-item"><div><strong>${mi[p.method]||'💵'} ${formatCurrency(p.amount)}</strong><br><small style="color:var(--text-medium);">${formatDate(p.date)}${p.note?' - '+esc(p.note):''}</small></div></div>`).join('');
        const totalPaid=(ev.payments||[]).reduce((s,p)=>s+(p.amount||0),0);
        const photoH=(ev.photos||[]).length>0?`<div class="card"><div class="card-header"><h3 class="card-title">📷 Fotos</h3></div><div class="photo-scroll">${ev.photos.map((p,i)=>`<img src="${p}" class="photo-thumb" onclick="viewPhoto(${i},'detail')">`).join('')}</div></div>`:'';
        const liH=(ev.lineItems||[]).length>0?`<div class="card"><div class="card-header"><h3 class="card-title">📋 Cotización</h3></div><table style="width:100%;border-collapse:collapse;font-size:0.9rem;"><tr style="border-bottom:2px solid var(--border);"><th style="text-align:left;padding:8px;color:var(--text-medium);font-weight:600;">Descripción</th><th style="text-align:right;padding:8px;color:var(--text-medium);font-weight:600;">Precio</th><th style="text-align:center;padding:8px;color:var(--text-medium);font-weight:600;">Qtd</th><th style="text-align:right;padding:8px;color:var(--text-medium);font-weight:600;">Total</th></tr>${ev.lineItems.map(li=>`<tr style="border-bottom:1px solid var(--border);"><td style="padding:8px;">${esc(li.description||'-')}${li.note?'<br><small style="color:var(--text-medium);">'+esc(li.note)+'</small>':''}</td><td style="text-align:right;padding:8px;">${formatCurrency(li.unitPrice||0)}</td><td style="text-align:center;padding:8px;">${li.quantity||1}</td><td style="text-align:right;padding:8px;font-weight:600;">${formatCurrency((li.unitPrice||0)*(li.quantity||1))}</td></tr>`).join('')}<tr><td colspan="3" style="text-align:right;padding:10px 8px;font-weight:700;">TOTAL</td><td style="text-align:right;padding:10px 8px;font-weight:700;font-size:1.1rem;">${formatCurrency(ev.lineItems.reduce((s,li)=>s+(li.unitPrice||0)*(li.quantity||1),0))}</td></tr></table></div>`:'';

        c.innerHTML=`
            <div class="card"><div class="card-header"><h3 class="card-title">${esc(ev.clientName)}</h3><span class="card-badge ${ev.status==='paid'?'badge-paid':ev.status==='partial'?'badge-partial':'badge-pending'}">${ev.status==='paid'?'Pagado':ev.status==='partial'?'Parcial':'Pendiente'}</span></div>
            <div class="payment-row"><span class="payment-label">📅 Fecha</span><span class="payment-value">${formatDate(ev.eventDate)}</span></div>
            <div class="payment-row"><span class="payment-label">📍 Lugar</span><span class="payment-value">${esc(ev.venue||'No especificado')}</span></div>
            <div class="payment-row"><span class="payment-label">👥 Invitados</span><span class="payment-value">${ev.guestCount||'-'}</span></div>
            <div class="payment-row"><span class="payment-label">📱 WhatsApp</span><span class="payment-value">${esc(ev.clientPhone||'-')}</span></div></div>

            <div class="card"><div class="card-header"><h3 class="card-title">🎂 Servicios</h3></div><div style="display:flex;flex-wrap:wrap;gap:5px;">${svcH||'<p style="color:var(--text-medium);">Sin servicios</p>'}</div></div>

            ${liH}

            <div class="card"><div class="card-header"><h3 class="card-title">💰 Pagos</h3></div>
            <div class="amount-display"><div class="amount-label">Total del Evento</div><div class="amount-value">${formatCurrency(ev.totalPrice)}</div></div>
            <div style="margin-top:12px;display:flex;gap:10px;">
                <div style="flex:1;text-align:center;padding:12px;background:#e8f5e9;border-radius:10px;"><div style="font-size:0.8rem;color:var(--text-medium);">Pagado</div><div style="font-size:1.2rem;font-weight:700;color:var(--success);">${formatCurrency(totalPaid)}</div></div>
                <div style="flex:1;text-align:center;padding:12px;background:${totalPaid>=ev.totalPrice?'#e8f5e9':'#fff8e6'};border-radius:10px;"><div style="font-size:0.8rem;color:var(--text-medium);">Restante</div><div style="font-size:1.2rem;font-weight:700;color:${totalPaid>=ev.totalPrice?'var(--success)':'var(--warning)'};">${formatCurrency(Math.max(0,ev.totalPrice-totalPaid))}</div></div>
            </div>
            ${totalPaid>0&&totalPaid<ev.totalPrice?`<div style="margin-top:10px;background:var(--border);border-radius:6px;height:8px;overflow:hidden;"><div style="height:100%;background:var(--success);border-radius:6px;width:${Math.min(100,Math.round(totalPaid/ev.totalPrice*100))}%;"></div></div><div style="text-align:center;font-size:0.8rem;color:var(--text-medium);margin-top:4px;">${Math.round(totalPaid/ev.totalPrice*100)}% cobrado</div>`:''}
            ${(ev.payments||[]).length>0?'<div style="margin-top:15px;">'+payH+'</div>':'<p style="color:var(--text-light);text-align:center;padding:12px;">Sin pagos registrados</p>'}
            ${ev.hasPlanner?`<div style="margin-top:15px;padding:15px;background:#fff8e6;border-radius:12px;border:1px solid #f0d78c;"><div style="display:flex;justify-content:space-between;align-items:center;"><div><div style="font-weight:600;">🤝 Comisión ${esc(ev.plannerName)}</div><div style="font-size:0.85rem;color:var(--text-medium);">${ev.commissionRate}% = ${formatCurrency(ev.commission)}</div></div><div onclick="toggleCommissionPaid('${esc(ev.id)}')" style="cursor:pointer;font-size:1.5rem;">${ev.commissionPaid?'✅':'⬜'}</div></div></div>`:''}</div>

            ${photoH}

            ${ev.notes?`<div class="card"><div class="card-header"><h3 class="card-title">📝 Notas</h3></div><p style="color:var(--text-medium);">${esc(ev.notes)}</p></div>`:''}

            <div style="display:flex;gap:8px;margin-bottom:10px;">
                <button class="btn btn-primary" onclick="generatePDF('devis')" style="flex:1;padding:12px;">📄 Cotización PDF</button>
                <button class="btn btn-success" onclick="generatePDF('nota')" style="flex:1;padding:12px;">🧾 Nota de Venta PDF</button>
            </div>
            <button class="btn btn-secondary" onclick="loadPdfTemplate()" style="margin-bottom:10px;padding:10px;font-size:0.85rem;" id="loadTemplateBtn">🖼️ ${pdfTemplateImg?'✅ Cambiar':'Cargar'} Template PDF</button>
            <button class="btn btn-secondary" onclick="saveAsTemplate('${esc(ev.id)}')" style="margin-bottom:10px;">📑 Guardar como Template</button>
            ${ev.clientPhone?`<button class="btn btn-whatsapp" onclick="contactWhatsApp('${esc(ev.clientPhone)}','${esc(ev.clientName)}')">📱 Contactar por WhatsApp</button>`:''}
            <button class="btn btn-primary" style="margin-top:10px;" onclick="editEvent('${esc(ev.id)}')">✏️ Modificar Evento</button>
            <button class="btn btn-danger" style="margin-top:10px;" onclick="deleteEvent('${esc(ev.id)}')">🗑️ Eliminar Evento</button>
            <button class="btn btn-secondary" style="margin-top:10px;" onclick="showSection('events')">← Volver a Eventos</button>`;
        showSection('eventDetail');
    }

    let _savingEvent = false;
    function togglePayment(eid,type) {
        if(_savingEvent)return; _savingEvent=true;
        const ev=appData.events.find(e=>e.id===eid); if(!ev){_savingEvent=false;return;}
        if(type==='deposit') ev.depositPaid=!ev.depositPaid; else ev.finalPaid=!ev.finalPaid;
        if(ev.depositPaid&&ev.finalPaid) ev.status='paid'; else if(ev.depositPaid||ev.finalPaid) ev.status='partial'; else ev.status='pending';
        saveData(); saveEventToFirebase(ev).finally(()=>{_savingEvent=false;}); showEventDetail(eid);
    }
    function toggleCommissionPaid(eid) {
        if(_savingEvent)return; _savingEvent=true;
        const ev=appData.events.find(e=>e.id===eid);if(!ev){_savingEvent=false;return;}
        ev.commissionPaid=!ev.commissionPaid;
        saveData();saveEventToFirebase(ev).finally(()=>{_savingEvent=false;});showEventDetail(eid);
    }
    function deleteEvent(eid) { showConfirm('Eliminar Evento','Este evento será eliminado permanentemente.','🗑️',function(){appData.events=appData.events.filter(e=>e.id!==eid);saveData();deleteEventFromFirebase(eid);showToast('Evento eliminado','info');showSection('events');},'Eliminar','btn-danger'); }
    function editEvent(eid) {
        const ev=appData.events.find(e=>e.id===eid);if(!ev)return;
        editingEventId=eid;
        document.getElementById('formTitle').textContent='✏️ Modificar Evento';
        document.getElementById('clientName').value=ev.clientName||'';
        document.getElementById('clientPhone').value=ev.clientPhone||'';
        document.getElementById('eventDate').value=ev.eventDate||'';
        document.getElementById('guestCount').value=ev.guestCount||'';
        document.getElementById('totalPrice').value=ev.totalPrice||'';
        document.getElementById('eventNotes').value=ev.notes||'';
        const vs=document.getElementById('eventVenue');
        const kv=['Finca Paraíso','Hacienda de Cortés','Jardín Borda'];
        if(kv.includes(ev.venue)){vs.value=ev.venue;document.getElementById('otherVenueGroup').style.display='none';}
        else if(ev.venue){vs.value='Otro';document.getElementById('otherVenue').value=ev.venue;document.getElementById('otherVenueGroup').style.display='block';}
        else{vs.value='';document.getElementById('otherVenueGroup').style.display='none';}
        document.getElementById('hasPlanner').checked=ev.hasPlanner||false;
        document.getElementById('plannerName').value=ev.plannerName||'';
        document.getElementById('commissionRate').value=ev.commissionRate||10;
        document.getElementById('plannerFields').style.display=ev.hasPlanner?'block':'none';
        document.getElementById('commissionRow').style.display=ev.hasPlanner?'flex':'none';
        selectedServices=ev.services||[];
        document.querySelectorAll('.service-card').forEach(c=>{c.classList.toggle('selected',selectedServices.includes(c.dataset.service));});
        updateServiceDetails();
        if(ev.serviceDetails) Object.entries(ev.serviceDetails).forEach(([s,d])=>{const el=document.getElementById('service_'+s+'_details');if(el)el.value=d;});
        currentPayments=[...(ev.payments||[])]; formPhotos=[...(ev.photos||[])]; lineItems=[...(ev.lineItems||[])];
        calculatePayments(); renderFormPayments(); renderFormPhotos(); renderLineItems();
        showSection('newEvent');
    }

    // ==================== EXPENSES ====================
    function addExpense() {
        const desc=document.getElementById('expenseDesc').value.trim();
        const cat=document.getElementById('expenseCategory').value;
        const amt=parseFloat(document.getElementById('expenseAmount').value)||0;
        if(!desc||amt<=0){showToast('Completa la descripción y el monto','warning');return;}
        const exp={id:'local_'+Date.now(),description:desc,category:cat,amount:amt,month:expenseMonth,year:expenseYear,createdAt:new Date().toISOString()};
        appData.expenses.push(exp); saveData(); saveExpenseToFirebase(exp);
        document.getElementById('expenseDesc').value=''; document.getElementById('expenseAmount').value='';
        renderExpenses();
    }
    function renderExpenses() {
        const c=document.getElementById('expensesList');if(!c)return;
        const exps=appData.expenses.filter(e=>e.month===expenseMonth&&e.year===expenseYear);
        const total=exps.reduce((s,e)=>s+e.amount,0);
        const tb=document.getElementById('totalExpensesBadge');if(tb)tb.textContent=formatCurrency(total);
        if(exps.length===0){c.innerHTML='<div style="text-align:center;padding:20px;color:var(--text-medium);">Sin gastos este mes</div>';return;}
        const ci={ingredientes:'🥚',transporte:'🚗',equipo:'🔧',marketing:'📣',otro:'📦'};
        c.innerHTML=exps.map(e=>`<div class="expense-item"><div class="expense-info"><div class="expense-desc">${ci[e.category]||'📦'} ${esc(e.description)}</div></div><div class="expense-amount">${formatCurrency(e.amount)}</div><button class="delete-btn" onclick="deleteExpense('${esc(e.id)}')">×</button></div>`).join('');
    }
    function deleteExpense(eid) { appData.expenses=appData.expenses.filter(e=>e.id!==eid);saveData();deleteExpenseFromFirebase(eid);renderExpenses(); }
    function changeExpenseMonth(d) { expenseMonth+=d;if(expenseMonth>11){expenseMonth=0;expenseYear++;}else if(expenseMonth<0){expenseMonth=11;expenseYear--;}updateExpenseMonthDisplay();renderExpenses(); }
    function updateExpenseMonthDisplay() { const m=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];document.getElementById('expenseMonthDisplay').textContent=m[expenseMonth]+' '+expenseYear; }

    // ==================== DASHBOARD ====================
    function changeMonth(d) { currentMonth+=d;if(currentMonth>11){currentMonth=0;currentYear++;}else if(currentMonth<0){currentMonth=11;currentYear--;}updateMonthDisplay();updateDashboard();setTimeout(renderChart,200); }
    function updateMonthDisplay() { const m=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];document.getElementById('monthDisplay').textContent=m[currentMonth]+' '+currentYear; }

    function updateDashboard() {
        const mEvs=appData.events.filter(e=>{const d=new Date(e.eventDate);return d.getMonth()===currentMonth&&d.getFullYear()===currentYear;});
        const mExps=appData.expenses.filter(e=>e.month===currentMonth&&e.year===currentYear);
        const totalRev=mEvs.reduce((s,e)=>s+(e.totalPrice||e.netAmount||0),0);
        const totalExp=mExps.reduce((s,e)=>s+e.amount,0);
        const netInc=totalRev-totalExp;
        let rr=1;if(totalRev>50000)rr=2;else if(totalRev>25000)rr=1.5;
        const tax=totalRev*(rr/100);
        const netP=netInc-tax;
        document.getElementById('dashEventCount').textContent=mEvs.length;
        document.getElementById('dashRevenue').textContent=formatCurrency(totalRev);
        document.getElementById('dashExpenses').textContent=formatCurrency(totalExp);
        document.getElementById('dashNet').textContent=formatCurrency(netInc);
        document.getElementById('dashResicoBase').textContent=formatCurrency(totalRev);
        document.getElementById('dashResicoRate').textContent=rr+'%';
        document.getElementById('dashResicoTax').textContent=formatCurrency(tax);
        document.getElementById('dashNetProfit').textContent=formatCurrency(netP);

        // Extra stats
        const avgVal=mEvs.length>0?totalRev/mEvs.length:0;
        const paidCount=mEvs.filter(e=>e.status==='paid').length;
        const compRate=mEvs.length>0?Math.round(paidCount/mEvs.length*100):0;
        // Best month this year
        let bestM='',bestV=0;
        for(let i=0;i<12;i++){const mv=appData.events.filter(e=>{const d=new Date(e.eventDate);return d.getMonth()===i&&d.getFullYear()===currentYear;}).reduce((s,e)=>s+(e.totalPrice||0),0);if(mv>bestV){bestV=mv;bestM=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][i];}}
        const es=document.getElementById('dashExtraStats');
        es.innerHTML=`<div class="stat-card"><div class="stat-icon">📊</div><div class="stat-value">${formatCurrency(avgVal)}</div><div class="stat-label">Promedio/Evento</div></div><div class="stat-card"><div class="stat-icon">✅</div><div class="stat-value">${compRate}%</div><div class="stat-label">Cobrado</div></div><div class="stat-card"><div class="stat-icon">🏆</div><div class="stat-value">${bestM||'-'}</div><div class="stat-label">Mejor Mes</div></div><div class="stat-card"><div class="stat-icon">📈</div><div class="stat-value">${formatCurrency(bestV)}</div><div class="stat-label">Mejor Ingreso</div></div>`;

        // Commission summary
        const pg={};
        mEvs.forEach(e=>{if(e.hasPlanner&&e.commission>0){const nn=(e.plannerName||'Sin nombre').trim().toLowerCase();const dn=e.plannerName||'Sin nombre';if(!pg[nn])pg[nn]={displayName:dn,events:[]};pg[nn].events.push({eventId:e.id,clientName:e.clientName,commission:e.commission,commissionPaid:e.commissionPaid||false});}});
        const cc=document.getElementById('commissionSummary');
        if(Object.keys(pg).length===0){cc.innerHTML='<p style="color:var(--text-medium);text-align:center;">Sin comisiones este mes</p>';}
        else{
            let tc=0,pc2=0,h='';
            Object.values(pg).forEach(g=>{const gt=g.events.reduce((s,e)=>s+e.commission,0);const gp=g.events.filter(e=>e.commissionPaid).reduce((s,e)=>s+e.commission,0);const ap=g.events.every(e=>e.commissionPaid);tc+=gt;pc2+=gp;
            h+=`<div style="background:${ap?'#e8f5e9':'#fff8e6'};padding:12px;border-radius:10px;margin-bottom:10px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><span style="font-weight:700;">🤝 ${g.displayName}</span><span style="font-weight:700;color:${ap?'var(--success)':'var(--warning)'};">${formatCurrency(gt)}</span></div>${g.events.map(e=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-top:1px solid rgba(0,0,0,0.1);"><span style="font-size:0.85rem;color:var(--text-medium);">${e.clientName}</span><div style="display:flex;align-items:center;gap:8px;"><span style="font-size:0.85rem;">${formatCurrency(e.commission)}</span><span onclick="toggleCommissionPaidFromDashboard('${e.eventId}')" style="cursor:pointer;font-size:1.2rem;">${e.commissionPaid?'✅':'⬜'}</span></div></div>`).join('')}</div>`;});
            const pend=tc-pc2;
            h+=`<div style="border-top:2px solid var(--border);margin-top:10px;padding-top:15px;"><div class="payment-row"><span class="payment-label" style="font-weight:700;">Total Comisiones</span><span class="payment-value" style="font-weight:700;">${formatCurrency(tc)}</span></div><div class="payment-row"><span class="payment-label" style="color:var(--success);">✅ Pagado</span><span class="payment-value" style="color:var(--success);">${formatCurrency(pc2)}</span></div><div class="payment-row"><span class="payment-label" style="color:var(--warning);">⬜ Pendiente</span><span class="payment-value" style="color:var(--warning);">${formatCurrency(pend)}</span></div></div>`;
            cc.innerHTML=h;
        }
    }
    function toggleCommissionPaidFromDashboard(eid) {
        if(_savingEvent)return; _savingEvent=true;
        const ev=appData.events.find(e=>e.id===eid);if(!ev){_savingEvent=false;return;}
        ev.commissionPaid=!ev.commissionPaid;
        saveData();saveEventToFirebase(ev).finally(()=>{_savingEvent=false;});updateDashboard();
    }

    // ==================== CHART ====================
    function renderChart() {
        const canvas=document.getElementById('revenueChart');if(!canvas)return;
        if(revenueChart){revenueChart.destroy();revenueChart=null;}
        const ms=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
        const data=[],prevData=[];
        for(let i=0;i<12;i++){
            data.push(appData.events.filter(e=>{const d=new Date(e.eventDate);return d.getMonth()===i&&d.getFullYear()===currentYear;}).reduce((s,e)=>s+(e.totalPrice||0),0));
            prevData.push(appData.events.filter(e=>{const d=new Date(e.eventDate);return d.getMonth()===i&&d.getFullYear()===currentYear-1;}).reduce((s,e)=>s+(e.totalPrice||0),0));
        }
        revenueChart=new Chart(canvas,{type:'bar',data:{labels:ms,datasets:[{label:currentYear+'',data:data,backgroundColor:'rgba(212,165,116,0.7)',borderColor:'#d4a574',borderWidth:2,borderRadius:6},{label:(currentYear-1)+'',data:prevData,backgroundColor:'rgba(139,115,85,0.3)',borderColor:'#8b7355',borderWidth:1,borderRadius:6}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true,labels:{font:{family:'Nunito'}}}},scales:{y:{beginAtZero:true,ticks:{callback:v=>'$'+v.toLocaleString()}},x:{ticks:{font:{family:'Nunito'}}}}}});
    }

    // ==================== NOTIFICATIONS ====================
    function computeNotifications() {
        const dismissed=JSON.parse(localStorage.getItem('lpp_dismissed_notifs')||'[]');
        const now=new Date();now.setHours(0,0,0,0);
        notifications=[];
        appData.events.forEach(ev=>{
            if(!ev.eventDate)return;
            const ed=new Date(ev.eventDate+'T12:00:00');
            const diff=Math.ceil((ed-now)/86400000);
            // Upcoming in 3 days
            if(diff>=0&&diff<=3){const id='upcoming_'+ev.id;if(!dismissed.includes(id))notifications.push({id,type:'urgent',icon:'📅',title:diff===0?'HOY: '+ev.clientName:diff===1?'MAÑANA: '+ev.clientName:'En '+diff+' días: '+ev.clientName,sub:ev.venue||'',eventId:ev.id});}
            // Overdue payment
            if(diff<0&&ev.status!=='paid'){const id='overdue_'+ev.id;if(!dismissed.includes(id))notifications.push({id,type:'warning',icon:'💰',title:'Pago pendiente: '+ev.clientName,sub:formatCurrency(ev.totalPrice),eventId:ev.id});}
        });
        // Update badge
        const badge=document.getElementById('notifBadge');
        if(badge){if(notifications.length>0){badge.style.display='flex';badge.textContent=notifications.length;}else{badge.style.display='none';}}
    }
    function toggleNotifications() {
        const m=document.getElementById('notifModal');
        if(m.style.display==='none'){
            m.style.display='block';
            const c=document.getElementById('notifList');
            if(notifications.length===0){c.innerHTML='<p style="text-align:center;color:var(--text-medium);padding:20px;">Sin notificaciones 🎉</p>';}
            else{c.innerHTML=notifications.map(n=>`<div class="notif-item notif-${n.type}" onclick="tapNotif('${n.eventId}','${n.id}')"><span style="font-size:1.5rem;">${n.icon}</span><div style="flex:1;"><div style="font-weight:600;">${n.title}</div><div style="font-size:0.85rem;color:var(--text-medium);">${n.sub}</div></div><span onclick="event.stopPropagation();dismissNotif('${n.id}')" style="font-size:1.2rem;padding:4px;">✕</span></div>`).join('');}
        } else { m.style.display='none'; }
    }
    function dismissNotif(id) { const d=JSON.parse(localStorage.getItem('lpp_dismissed_notifs')||'[]');d.push(id);localStorage.setItem('lpp_dismissed_notifs',JSON.stringify(d));computeNotifications();toggleNotifications();toggleNotifications(); }
    function tapNotif(eid,nid) { dismissNotif(nid); document.getElementById('notifModal').style.display='none'; showEventDetail(eid); }

    // ==================== TEMPLATES ====================
    function saveAsTemplate(eid) {
        const ev=appData.events.find(e=>e.id===eid);if(!ev)return;
        const name=prompt('Nombre del template:',ev.clientName+' - Template');if(!name)return;
        const tpl={id:'tpl_'+Date.now(),name,services:ev.services||[],serviceDetails:ev.serviceDetails||{},totalPrice:ev.totalPrice,hasPlanner:ev.hasPlanner,plannerName:ev.plannerName,commissionRate:ev.commissionRate,venue:ev.venue,guestCount:ev.guestCount,notes:ev.notes,lineItems:ev.lineItems||[]};
        appTemplates.push(tpl);
        localStorage.setItem('lpp_templates',JSON.stringify(appTemplates));
        saveTemplateToFirebase(tpl);
        showToast('Template guardado!','success');
    }
    function applyTemplate(tid) {
        const t=appTemplates.find(x=>x.id===tid);if(!t)return;
        clearFormData();
        if(t.totalPrice) document.getElementById('totalPrice').value=t.totalPrice;
        if(t.venue){const vs=document.getElementById('eventVenue');const kv=['Finca Paraíso','Hacienda de Cortés','Jardín Borda'];if(kv.includes(t.venue))vs.value=t.venue;else{vs.value='Otro';document.getElementById('otherVenue').value=t.venue;document.getElementById('otherVenueGroup').style.display='block';}}
        if(t.guestCount) document.getElementById('guestCount').value=t.guestCount;
        if(t.hasPlanner){document.getElementById('hasPlanner').checked=true;document.getElementById('plannerName').value=t.plannerName||'';document.getElementById('commissionRate').value=t.commissionRate||10;togglePlannerFields();}
        if(t.notes) document.getElementById('eventNotes').value=t.notes;
        selectedServices=t.services||[];
        document.querySelectorAll('.service-card').forEach(c=>{c.classList.toggle('selected',selectedServices.includes(c.dataset.service));});
        updateServiceDetails();
        if(t.serviceDetails) Object.entries(t.serviceDetails).forEach(([s,d])=>{const el=document.getElementById('service_'+s+'_details');if(el)el.value=d;});
        lineItems=[...(t.lineItems||[])]; renderLineItems();
        calculatePayments();
        closeTemplatePicker();
        showSection('newEvent');
    }
    function deleteTemplate(tid) { showConfirm('Eliminar Template','Este template será eliminado.','📑',function(){appTemplates=appTemplates.filter(t=>t.id!==tid);localStorage.setItem('lpp_templates',JSON.stringify(appTemplates));deleteTemplateFromFirebase(tid);renderTemplates();showToast('Template eliminado','info');},'Eliminar','btn-danger'); }
    function renderTemplates() {
        const c=document.getElementById('templatesList');if(!c)return;
        const nt=document.getElementById('noTemplates');
        if(appTemplates.length===0){c.innerHTML='';if(nt)nt.style.display='block';return;}
        if(nt)nt.style.display='none';
        c.innerHTML=appTemplates.map(t=>`<div class="template-item"><div style="flex:1;"><div style="font-weight:600;">${esc(t.name)}</div><div style="font-size:0.85rem;color:var(--text-medium);">${(t.services||[]).join(', ')} • ${formatCurrency(t.totalPrice||0)}</div></div><button class="delete-btn" onclick="deleteTemplate('${esc(t.id)}')" style="width:28px;height:28px;font-size:0.9rem;">×</button></div>`).join('');
    }
    function showTemplatePicker() {
        if(appTemplates.length===0){showToast('Sin templates — guarda uno desde el detalle de un evento','info');return;}
        const c=document.getElementById('templatePickerList');
        c.innerHTML=appTemplates.map(t=>`<div class="template-item" onclick="applyTemplate('${esc(t.id)}')"><span style="font-size:1.5rem;">📑</span><div style="flex:1;"><div style="font-weight:600;">${esc(t.name)}</div><div style="font-size:0.85rem;color:var(--text-medium);">${formatCurrency(t.totalPrice||0)}</div></div></div>`).join('');
        document.getElementById('templateModal').style.display='block';
    }
    function closeTemplatePicker() { document.getElementById('templateModal').style.display='none'; }

    // ==================== PDF TEMPLATE IMAGE ====================
    let pdfTemplateImg = localStorage.getItem('lpp_pdf_template') || null;

    function loadPdfTemplate() {
        const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*';
        inp.onchange=function(){
            if(!inp.files[0]) return;
            const reader=new FileReader();
            reader.onload=function(e){
                pdfTemplateImg=e.target.result;
                localStorage.setItem('lpp_pdf_template', pdfTemplateImg);
                // Update UI
                const ts=document.getElementById('templateStatus');
                const mb=document.getElementById('mainTemplateBtn');
                if(ts) ts.textContent='✅ Template cargado';
                if(mb) mb.innerHTML='🖼️ ✅ Template PDF cargado (cambiar)';
                showToast('Template PDF cargado!','success');
            };
            reader.readAsDataURL(inp.files[0]);
        };
        inp.click();
    }

    // ==================== PDF GENERATION ====================
    function generatePDF(type) {
        const ev=appData.events.find(e=>e.id===currentEventId);if(!ev)return;
        if(!pdfTemplateImg){showToast('Primero carga tu imagen de template PDF','warning');return;}
        const {jsPDF}=window.jspdf;
        const doc=new jsPDF({unit:'mm',format:'a4'});
        const pw=210, ph=297;
        const brown=[100,75,55];
        const brownLight=[140,115,95];
        const brownDark=[70,50,35];

        // Background: blank template image (logo + feuilles, no text)
        doc.addImage(pdfTemplateImg,'JPEG',0,0,pw,ph);

        // Template measurements (Image-1.jpg = 1415x2000px → A4 210x297mm)
        // 1st pink line: y≈607px → 90mm. 2nd pink line: y≈1456px → 216mm
        // White zone left edge: x≈75px → 11mm. Right edge: x≈1340px → 199mm
        // Usable zone: y=95mm to y=212mm (with 5mm margins from lines)
        // Horizontal center: 105mm. Left margin: 18mm. Right margin: 195mm

        const LM=18, RM=195, CX=105; // left margin, right margin, center x
        const TOP=96; // start text 6mm below first pink line

        // ====== CLIENT INFO ======
        let y=TOP;
        doc.setFontSize(12); doc.setTextColor(...brownDark);
        doc.text(ev.clientName.toUpperCase(),LM,y);
        y+=6;
        const snm={pastel:'Pastel',mesa_dulces:'Mesa de Dulces',postres:'Postres',quesos:'Mesa de Quesos',bebidas:'Bebidas',otro:'Otro'};
        const svcNames=(ev.services||[]).map(s=>snm[s]||s).join(' + ');
        doc.setFontSize(9); doc.setTextColor(...brown);
        if(svcNames){doc.text(svcNames,LM,y);y+=5;}
        if(ev.hasPlanner&&ev.plannerName){doc.text('WP: '+ev.plannerName,LM,y);y+=5;}

        // Date + venue - right aligned
        doc.setFontSize(9); doc.setTextColor(...brownLight);
        doc.text('Fecha evento : '+ev.eventDate.split('-').reverse().join('.'),RM,TOP,{align:'right'});
        if(ev.venue) doc.text(ev.venue,RM,TOP+6,{align:'right'});
        if(ev.guestCount) doc.text(ev.guestCount+' invitados',RM,TOP+12,{align:'right'});

        // Separator
        y=Math.max(y+4,114);
        doc.setDrawColor(210,185,175); doc.setLineWidth(0.3); doc.line(LM,y,RM,y);

        // ====== TABLE HEADER ======
        y+=7;
        doc.setFontSize(10); doc.setTextColor(...brownDark);
        doc.text('DESCRIPCION',LM+2,y);
        doc.text('PRECIO',108,y,{align:'center'});
        doc.text('QTD',140,y,{align:'center'});
        doc.text('PRECIO',178,y,{align:'center'});

        // ====== TABLE ROWS ======
        y+=8; doc.setFontSize(9); doc.setTextColor(...brown);
        const items=(ev.lineItems||[]).length>0 ? ev.lineItems : [{description:'Servicio completo',unitPrice:ev.totalPrice,quantity:1,note:''}];
        items.forEach(li=>{
            const sub=(li.unitPrice||0)*(li.quantity||1);
            const priceStr=(li.unitPrice===0||li.unitPrice===undefined)?'incluido':formatCurrency(li.unitPrice);
            const subStr=sub===0?'incluido':formatCurrency(sub);

            const descLines=doc.splitTextToSize(li.description||'-',75);
            doc.setTextColor(...brown);
            doc.text(descLines,LM+2,y);
            doc.text(priceStr,108,y,{align:'center'});
            doc.text(String(li.quantity||1),140,y,{align:'center'});
            doc.text(subStr,178,y,{align:'center'});
            y+=descLines.length*4.5;
            if(li.note){
                doc.setFontSize(8); doc.setTextColor(...brownLight);
                const noteLines=doc.splitTextToSize(li.note,75);
                doc.text(noteLines,LM+2,y);
                y+=noteLines.length*3.5;
                doc.setFontSize(9); doc.setTextColor(...brown);
            }
            y+=5;
        });

        // ====== TOTAL LINE (must stay above 2nd pink line at 216mm) ======
        // Separator before total
        doc.setDrawColor(180,130,120); doc.setLineWidth(0.5); doc.line(LM,y,RM,y);
        y+=7;
        doc.setFontSize(12); doc.setTextColor(...brownDark);
        doc.text('TOTAL',CX+15,y,{align:'center'});
        doc.text(formatCurrency(ev.totalPrice),178,y,{align:'center'});

        // Payment info (below total, still above 2nd line)
        const totalPaid=(ev.payments||[]).reduce((s,p)=>s+(p.amount||0),0);
        if(type==='devis' && totalPaid>0){
            y+=7; doc.setFontSize(8); doc.setTextColor(...brownLight);
            doc.text('Pagado: '+formatCurrency(totalPaid)+' | Restante: '+formatCurrency(ev.totalPrice-totalPaid),CX,y,{align:'center'});
        } else if(type==='devis'){
            y+=7; doc.setFontSize(8); doc.setTextColor(...brownLight);
            doc.text('Anticipo 50%: '+formatCurrency(ev.totalPrice/2)+' | Liquidacion 50%: '+formatCurrency(ev.totalPrice/2),CX,y,{align:'center'});
        }
        if(type==='nota'&&(ev.payments||[]).length>0){
            y+=8; doc.setFontSize(8); doc.setTextColor(...brown);
            const mi={'efectivo':'Efectivo','transferencia':'Transferencia','tarjeta':'Tarjeta'};
            ev.payments.forEach(p=>{
                doc.text(formatDate(p.date)+' - '+(mi[p.method]||p.method),LM+4,y);
                doc.text(formatCurrency(p.amount),178,y,{align:'center'});
                y+=4.5;
            });
            y+=2; doc.setFontSize(9); doc.setTextColor(...brownDark);
            doc.text('Total pagado: '+formatCurrency(totalPaid)+' | Restante: '+formatCurrency(ev.totalPrice-totalPaid),CX,y,{align:'center'});
        }

        // ====== "Merci !" in footer zone (between 2nd line ~216mm and bottom leaves ~234mm) ======
        doc.setFontSize(26); doc.setTextColor(...brownDark);
        doc.text('Merci !',CX,232,{align:'center'});

        doc.save((type==='devis'?'Cotizacion':'NotaDeVenta')+'_'+ev.clientName.replace(/\s/g,'_')+'.pdf');
    }

    // ==================== UTILITIES ====================
    function formatDate(ds) { if(!ds)return''; const d=new Date(ds); return d.toLocaleDateString('es-MX',{weekday:'short',day:'numeric',month:'short',year:'numeric'}); }
    function contactWhatsApp(phone,name) { const cp=phone.replace(/\D/g,'');const msg=encodeURIComponent('Hola '+name+', te escribo de La Petite Parisienne 🥐');window.open('https://wa.me/'+cp+'?text='+msg,'_blank'); }
    function sendMonthlyReport() {
        const ms=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
        const mEvs=appData.events.filter(e=>{const d=new Date(e.eventDate);return d.getMonth()===currentMonth&&d.getFullYear()===currentYear;});
        const mExps=appData.expenses.filter(e=>e.month===currentMonth&&e.year===currentYear);
        const rev=mEvs.reduce((s,e)=>s+(e.totalPrice||e.netAmount||0),0);
        const exp=mExps.reduce((s,e)=>s+e.amount,0);
        const r=`🥐 *Reporte La Petite Parisienne*\n📅 ${ms[currentMonth]} ${currentYear}\n\n📋 Eventos: ${mEvs.length}\n💰 Ingresos: ${formatCurrency(rev)}\n💸 Gastos: ${formatCurrency(exp)}\n✅ Neto: ${formatCurrency(rev-exp)}`;
        window.open('https://wa.me/?text='+encodeURIComponent(r),'_blank');
    }
    function updateQuickStats() {
        const now=new Date();
        const mEvs=appData.events.filter(e=>{const d=new Date(e.eventDate);return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();});
        const mExps=appData.expenses.filter(e=>e.month===now.getMonth()&&e.year===now.getFullYear());
        const rev=mEvs.reduce((s,e)=>s+(e.totalPrice||e.netAmount||0),0);
        const exp=mExps.reduce((s,e)=>s+e.amount,0);
        const qec=document.getElementById('quickEventCount');if(qec)qec.textContent=mEvs.length;
        const qr=document.getElementById('quickRevenue');if(qr)qr.textContent=formatCurrency(rev);
        const qe=document.getElementById('quickExpenses');if(qe)qe.textContent=formatCurrency(exp);
        const qn=document.getElementById('quickNet');if(qn)qn.textContent=formatCurrency(rev-exp);
    }
