/* app.js
   Cockpit Crontab Manager - UI + logic.
   Full client-side code intended to be run inside Cockpit.
   Uses cockpit.spawn to run commands on the host.
*/

(function(){
  // Guard: if cockpit is not present (e.g., testing outside Cockpit), provide a minimal stub
  const cockpitPresent = (typeof cockpit !== "undefined");
  if (!cockpitPresent) {
    window.cockpit = {
      spawn: (args) => {
        console.warn("cockpit.spawn unavailable. This is a UI mock. Command:", args);
        return Promise.reject({ error: "cockpit.spawn not available outside Cockpit" });
      }
    };
  }

  // Elements
  const statusEl = document.getElementById('system-status');
  const errorContainer = document.getElementById('error-container');
  const listEl = document.getElementById('crontab-list');
  const refreshBtn = document.getElementById('refreshBtn');
  const addForm = document.getElementById('addForm');
  const cronExpr = document.getElementById('cronExpr');
  const cronCmd = document.getElementById('cronCmd');
  const logArea = null;
  const confirmModal = document.getElementById('confirmModal');
  const confirmYes = document.getElementById('confirmYes');
  const confirmNo = document.getElementById('confirmNo');
  const openEditorBtn = document.getElementById('openEditorBtn');
  const exampleBtn = document.getElementById('exampleBtn');
  const userSelect = document.getElementById('userSelect');
  const editorModal = document.getElementById('editorModal');
  const editorArea = document.getElementById('editorArea');
  const editorSave = document.getElementById('editorSave');
  const editorCancel = document.getElementById('editorCancel');
  const editorClose = document.getElementById('editorClose');
  const addModal = document.getElementById('addModal');
  const addCancel = document.getElementById('addCancel');
  const addClose = document.getElementById('addClose');
  const openAddBtn = document.getElementById('openAddBtn');

  // State
  let rawCrontab = "";
  let parsedLines = []; // {type: 'entry'|'comment'|'blank', text, lineIdx}
  let toDeleteIndex = null;
  let currentUser = null;
  let adminPermission = null;
  let limitedAccess = false;

  // Helpers
  function log(msg){
    const now = new Date().toISOString().replace('T',' ').slice(0,19);
    if (logArea) {
      logArea.textContent = `${now} - ${msg}\n` + logArea.textContent;
    } else {
      console.info(`${now} - ${msg}`);
    }
  }

  function setError(msg){
    errorContainer.classList.remove('hidden');
    errorContainer.textContent = msg;
  }
  function clearError(){
    errorContainer.classList.add('hidden');
    errorContainer.textContent = '';
  }

  function showStatus(msg){
    if (!statusEl) return;
    statusEl.textContent = msg;
  }

  function getSelectedUserValue(){
    if (!userSelect) return currentUser || null;
    return userSelect.value || currentUser || null;
  }

  function getUserForCrontabFlag(){
    const value = getSelectedUserValue();
    return value || null;
  }

  function isDifferentUser(){
    const target = getUserForCrontabFlag();
    if (!target) return false;
    if (!currentUser) return true;
    return target !== currentUser;
  }

  function userDisplayName(){
    const target = getUserForCrontabFlag();
    if (!target) return currentUser ? currentUser : 'current user';
    return target;
  }

  function spawnCommand(args, requireSuperuser){
    const options = requireSuperuser ? { superuser: "require" } : {};
    return cockpit.spawn(args, options);
  }

  function isAccessDenied(err){
    if (!err) return false;
    if (err.problem === 'access-denied') return true;
    const msg = err.message || err.toString();
    return /permission denied|access denied|authorization|not authorized/i.test(msg);
  }

  function errorText(err){
    if (!err) return '';
    const parts = [];
    if (err.stderr) parts.push(err.stderr);
    if (err.stdout) parts.push(err.stdout);
    if (err.message) parts.push(err.message);
    if (err.problem) parts.push(err.problem);
    const normalized = parts.map((p) => {
      if (Array.isArray(p)) return p.join('');
      return String(p);
    });
    const combined = normalized.join('\n');
    if (typeof combined === 'string') return combined;
    try {
      return JSON.stringify(err);
    } catch (e) {
      return String(err);
    }
  }

  function applyCurrentUserSelection(){
    if (!userSelect || !currentUser) return;
    const options = Array.from(userSelect.options).map(o => o.value);
    if (options.includes(currentUser)){
      const previous = userSelect.value;
      userSelect.value = currentUser;
      if (previous !== currentUser){
        userSelect.dispatchEvent(new Event('change'));
      }
    }
  }

  function ensureCurrentUserOption(){
    if (!userSelect) return;
    userSelect.innerHTML = '';
    if (currentUser){
      const opt = document.createElement('option');
      opt.value = currentUser;
      opt.textContent = currentUser;
      userSelect.appendChild(opt);
      userSelect.value = currentUser;
    }
  }

  function updateUserSelectVisibility(){
    if (!userSelect) return;
    if (limitedAccess){
      userSelect.classList.add('hidden');
      userSelect.setAttribute('aria-hidden', 'true');
      ensureCurrentUserOption();
    } else {
      userSelect.classList.remove('hidden');
      userSelect.removeAttribute('aria-hidden');
    }
  }

  function initAccessMode(){
    if (!cockpit || typeof cockpit.permission !== 'function') return;
    adminPermission = cockpit.permission({ admin: true });
    limitedAccess = !adminPermission.allowed;
    updateUserSelectVisibility();
    adminPermission.addEventListener('changed', () => {
      limitedAccess = !adminPermission.allowed;
      updateUserSelectVisibility();
      if (!limitedAccess){
        loadUsers();
      }
    });
  }

  // Basic cron expression validator (very permissive)
  function validateCron(expr){
    // Accept 5-field or 6-field (with year) crude check
    const parts = expr.trim().split(/\s+/);
    if (parts.length < 5 || parts.length > 7) return false;
    // further simple check: fields not empty
    return parts.every(Boolean);
  }

  // Parse crontab into lines preserving comments/blank lines
  function parseCrontab(raw){
    const lines = raw.split(/\r?\n/);
    const out = [];
    lines.forEach((l, idx) => {
      if (l.trim() === "") out.push({type:'blank', text:l, lineIdx: idx});
      else if (/^\s*#/.test(l)) out.push({type:'comment', text:l, lineIdx: idx});
      else out.push({type:'entry', text:l, lineIdx: idx});
    });
    return out;
  }

  // Render list
  function renderList(){
    listEl.innerHTML = '';
    if (!rawCrontab || rawCrontab.trim() === ""){
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = `No crontab entries for ${userDisplayName()}.`;
      listEl.appendChild(empty);
      return;
    }

    parsedLines.forEach((lineObj, idx) => {
      const row = document.createElement('div');
      row.className = 'cron-line';
      if (lineObj.type === 'entry'){
        const meta = document.createElement('div');
        meta.className = 'cron-meta';
        meta.textContent = lineObj.text;
        row.appendChild(meta);

        const actions = document.createElement('div');
        actions.className = 'cron-actions';
        const del = document.createElement('button');
        del.className = 'btn btn-ghost';
        del.setAttribute('aria-label', 'Delete cron job');
        del.textContent = 'Delete';
        del.addEventListener('click', ()=> confirmDelete(idx));
        actions.appendChild(del);
        row.appendChild(actions);
      } else if (lineObj.type === 'comment'){
        const c = document.createElement('div');
        c.className = 'cron-comment';
        c.textContent = lineObj.text;
        row.appendChild(c);
      } else {
        const b = document.createElement('div');
        b.textContent = '';
        row.appendChild(b);
      }

      listEl.appendChild(row);
    });
  }

  // Confirm deletion modal
  function showConfirmModal(){
    confirmModal.classList.remove('hidden');
    confirmModal.hidden = false;
    confirmModal.style.display = 'flex';
  }

  function hideConfirmModal(){
    confirmModal.classList.add('hidden');
    confirmModal.hidden = true;
    confirmModal.style.display = 'none';
  }

  function showEditorModal(){
    editorModal.classList.remove('hidden');
    editorModal.hidden = false;
    editorModal.style.display = 'flex';
  }

  function hideEditorModal(){
    editorModal.classList.add('hidden');
    editorModal.hidden = true;
    editorModal.style.display = 'none';
  }

  function showAddModal(){
    addModal.classList.remove('hidden');
    addModal.hidden = false;
    addModal.style.display = 'flex';
  }

  function hideAddModal(){
    addModal.classList.add('hidden');
    addModal.hidden = true;
    addModal.style.display = 'none';
  }

  function confirmDelete(index){
    toDeleteIndex = index;
    showConfirmModal();
    document.getElementById('confirmText').textContent = `Remove this entry?\n\n${parsedLines[index].text}`;
  }
  confirmNo.addEventListener('click', ()=>{
    toDeleteIndex = null;
    hideConfirmModal();
  });

  confirmYes.addEventListener('click', ()=>{
    hideConfirmModal();
    if (toDeleteIndex !== null) {
      deleteEntryAt(toDeleteIndex);
      toDeleteIndex = null;
    }
  });

  // High-level operations using cockpit.spawn
  async function checkCronAvailable(){
    showStatus('Checking for crontab and cron services...');
    clearError();
    // Check if crontab binary exists
    try {
      await cockpit.spawn(["which","crontab"]);
    } catch (err){
      setError('`crontab` command not found on this host. Ensure cron/cronie is installed.');
      showStatus('Cron not available');
      log('crontab binary missing.');
      throw new Error('crontab-missing');
    }

    // Check if systemctl exists before probing services
    let systemctlAvailable = true;
    try {
      await cockpit.spawn(["which","systemctl"]);
    } catch (err) {
      systemctlAvailable = false;
    }

    if (!systemctlAvailable){
      showStatus('Cron available');
      clearError();
      log('systemctl not available; skipping cron service checks.');
      return;
    }

    // Check service active for common service names: cron or crond
    const services = ['cron','crond'];
    let active = false;
    for (const s of services){
      try {
        // use systemctl is-active
        const res = await cockpit.spawn(["systemctl","is-active",s]);
        const out = typeof res === 'string' ? res : (res.stdout || '');
        if (out && out.trim() === 'active') {
          active = true;
          break;
        }
      } catch (e){
        // ignore, try next
      }
    }

    if (!active){
      // Not necessarily an error — some containers may not use systemd. We warn but allow using crontab.
      setError('No system cron service (cron/crond) is reported as active. crontab may still work but scheduling might not run.');
      showStatus('Cron service not active');
      log('system cron service not active (cron/crond not running).');
      // don't throw — allow user to continue (they may be on system without systemd).
    } else {
      showStatus('Cron available');
      clearError();
    }
  }

  async function loadCrontab(){
    showStatus(`Loading crontab for ${userDisplayName()}…`);
    try {
      const userFlag = getUserForCrontabFlag();
      const args = userFlag ? ["crontab","-u", userFlag, "-l"] : ["crontab","-l"];
      const res = await spawnCommand(args, isDifferentUser());
      // cockpit.spawn sometimes returns object; handle common return shapes
      let out = '';
      if (typeof res === 'string') out = res;
      else if (res.stdout) out = res.stdout;
      else if (Array.isArray(res)) out = res.join('');
      rawCrontab = out;
      parsedLines = parseCrontab(rawCrontab);
      renderList();
      showStatus(`Crontab loaded for ${userDisplayName()}`);
      log(`Loaded crontab for ${userDisplayName()}.`);
    } catch (err){
      if (isAccessDenied(err)){
        setError(`Admin access required to read crontab for ${userDisplayName()}.`);
        showStatus('Permission denied');
        log(`Access denied loading crontab for ${userDisplayName()}.`);
        return;
      }
      // If crontab -l exits non-zero when crontab empty, handle gracefully
      // Cockpit spawn returns error object; try to parse stdout from error if present
      const output = errorText(err);
      if (output.toLowerCase().indexOf('no crontab for') !== -1){
        rawCrontab = '';
        parsedLines = [];
        renderList();
        showStatus(`No crontab for ${userDisplayName()}`);
        log(`No crontab for ${userDisplayName()}.`);
      } else {
        setError('Failed to read crontab: ' + (err.message || JSON.stringify(err)));
        showStatus('Error loading crontab');
        log('Error loading crontab: ' + (err.message || JSON.stringify(err)));
      }
    }
  }

  // Reinstall crontab by writing new content to a temp file on host and calling crontab <file>
  async function installCrontab(newContent){
    showStatus(`Installing crontab for ${userDisplayName()}…`);
    try {
      // create a temp file and write via tee (safer than relying on shell redirection)
      // Use mktemp
      const mk = await spawnCommand(["mktemp","-t","cockpit-cron-XXXXXX"], isDifferentUser());
      const tmp = (typeof mk === 'string') ? mk.trim() : (mk.stdout && mk.stdout.trim ? mk.stdout.trim() : mk.trim && mk.trim());
      if (!tmp){
        throw new Error('Failed to create temp file on host.');
      }
      // write content: use /bin/sh -c 'cat > tmp <<EOF ... EOF'
      const writeCmd = ["/bin/sh","-c", "cat > " + tmp + " <<'EOF'\n" + newContent + "\nEOF\n"];
      await spawnCommand(writeCmd, isDifferentUser());
      // install
      const userFlag = getUserForCrontabFlag();
      const installArgs = userFlag ? ["crontab","-u", userFlag, tmp] : ["crontab", tmp];
      await spawnCommand(installArgs, isDifferentUser());
      // remove tmp
      await spawnCommand(["rm","-f", tmp], isDifferentUser());
      log(`Installed updated crontab for ${userDisplayName()}.`);
      showStatus(`Crontab installed for ${userDisplayName()}`);
      await loadCrontab();
    } catch (err){
      if (isAccessDenied(err)){
        setError(`Admin access required to write crontab for ${userDisplayName()}.`);
        log(`Access denied installing crontab for ${userDisplayName()}.`);
      } else {
        setError('Failed to install crontab: ' + (err.message || JSON.stringify(err)));
        log('Install failed: ' + (err.message || JSON.stringify(err)));
      }
      showStatus('Install failed');
    }
  }

  // Add entry: append to existing rawCrontab (preserving newline)
  async function addEntry(expr, cmd){
    if (!validateCron(expr)){
      setError('Invalid cron expression. Provide a 5-field schedule (e.g. "*/10 * * * *").');
      return;
    }
    clearError();
    const line = expr.trim() + ' ' + cmd.trim();
    const newContent = (rawCrontab && rawCrontab.trim() !== '') ? (rawCrontab.trimEnd() + "\n" + line + "\n") : (line + "\n");
    await installCrontab(newContent);
  }

  // Delete at parsed index -> build new content dropping that entry line
  async function deleteEntryAt(parsedIndex){
    const newLines = parsedLines.filter((_,i) => i !== parsedIndex).map(p=>p.text);
    const newContent = newLines.join("\n") + "\n";
    await installCrontab(newContent);
  }

  // Events
  refreshBtn.addEventListener('click', ()=> loadCrontab());
  addForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const expr = cronExpr.value.trim();
    const cmd = cronCmd.value.trim();
    if (!expr || !cmd){
      setError('Both schedule and command are required.');
      return;
    }
    clearError();
    log(`Adding entry: ${expr} ${cmd}`);
    await addEntry(expr, cmd);
    // reset form
    cronExpr.value = '';
    cronCmd.value = '';
    hideAddModal();
  });

  openEditorBtn.addEventListener('click', async ()=>{
    try {
      editorArea.value = rawCrontab || '';
      showEditorModal();
      editorArea.focus();
    } catch (err){
      setError('Editor flow failed: ' + (err.message || JSON.stringify(err)));
      log('Editor failed: ' + (err.message || JSON.stringify(err)));
    }
  });

  function wireEditorButtons(){
    if (editorCancel){
      editorCancel.addEventListener('click', () => {
        hideEditorModal();
      });
    }
    if (editorClose){
      editorClose.addEventListener('click', () => {
        hideEditorModal();
      });
    }
    if (editorSave){
      editorSave.addEventListener('click', async () => {
        const content = editorArea.value || '';
        await installCrontab(content.endsWith('\n') ? content : content + '\n');
        hideEditorModal();
      });
    }
  }

  function wireAddButtons(){
    if (openAddBtn){
      openAddBtn.addEventListener('click', () => {
        showAddModal();
        cronExpr.focus();
      });
    }
    if (addCancel){
      addCancel.addEventListener('click', () => {
        hideAddModal();
      });
    }
    if (addClose){
      addClose.addEventListener('click', () => {
        hideAddModal();
      });
    }
  }

  exampleBtn.addEventListener('click', ()=>{
    cronExpr.value = "0 2 * * *";
    cronCmd.value = "/usr/local/bin/backup.sh";
  });

  // Initial load sequence
  async function init(){
    try {
      hideConfirmModal();
      hideEditorModal();
      hideAddModal();
      wireEditorButtons();
      wireAddButtons();
      await fetchCurrentUser();
      initAccessMode();
      await checkCronAvailable();
      if (!limitedAccess) {
        await loadUsers();
      } else {
        ensureCurrentUserOption();
      }
      await loadCrontab();
    } catch (err){
      // If check failed fatally, we've already shown error
      console.warn("Init ended with", err);
    }
  }

  // Start
  init();

  async function fetchCurrentUser(){
    if (!(cockpit && typeof cockpit.user === 'function')) return;
    try {
      const userResult = cockpit.user();
      if (userResult && typeof userResult.then === 'function'){
        const u = await userResult;
        if (u && u.name) currentUser = u.name;
      } else if (userResult && userResult.name){
        currentUser = userResult.name;
      }
    } catch (err){
      log('Failed to detect current user.');
    }
  }

  async function loadUsers(){
    if (!userSelect) return;
    try {
      const cmd = "awk -F: '($3>=1000 && $1!=\"nobody\" && $7!~/(nologin|false)$/){print $1}' /etc/passwd";
      const res = await cockpit.spawn(["/bin/sh","-c", cmd]);
      const out = typeof res === 'string' ? res : (res.stdout || '');
      const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const seen = new Set();
      if (currentUser) seen.add(currentUser);
      seen.add('root');
      lines.forEach((name) => seen.add(name));
      const users = Array.from(seen);
      users.sort();
      const rootIndex = users.indexOf('root');
      if (rootIndex > 0){
        users.splice(rootIndex, 1);
        users.unshift('root');
      }

      userSelect.innerHTML = '';
      users.forEach((name) => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        userSelect.appendChild(opt);
      });
      applyCurrentUserSelection();
    } catch (err){
      setError('Failed to list users: ' + (err.message || JSON.stringify(err)));
      log('Failed to list users: ' + (err.message || JSON.stringify(err)));
    }
  }

  if (userSelect){
    userSelect.addEventListener('change', async () => {
      rawCrontab = '';
      parsedLines = [];
      renderList();
      await loadCrontab();
    });
  }

})();
