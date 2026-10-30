/* Collège La Rivière — connexion à Supabase.
   Ce fichier fournit à l'application les mêmes services que la version Claude
   (base de données en temps réel, utilisateur, assistant IA, téléchargements),
   et affiche l'écran de connexion. */
(function () {
  'use strict';
  const CFG = window.CLR_CONFIG || {};
  const sb = window.supabase.createClient(CFG.url, CFG.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'clr-ecole-auth' }
  });
  window.CLR_SB = sb;

  /* ---------- téléphone → identifiant de connexion (identique au serveur) ---------- */
  function normPhone(v) {
    let p = String(v || '').replace(/\D/g, '');
    if (p.startsWith('00')) p = p.slice(2);
    if (p.length === 10 && p.startsWith('0')) p = '243' + p.slice(1);
    if (p.length === 9) p = '243' + p;
    return p;
  }
  const emailOf = d => d + '@ecole.koris-rdc.github.io';

  /* ---------- état ---------- */
  let ME = null;          // { uid, member }
  let readyResolve;
  const ready = new Promise(r => (readyResolve = r));
  const cache = {};       // col -> Map(id -> data)
  const subs = {};        // col -> Set({cb, err})
  const pending = {};     // 'col/id' -> nombre d'écritures en cours
  let loaded = false, channel = null, hiddenAt = 0;

  const mapOf = col => (cache[col] = cache[col] || new Map());
  function emit(col) {
    if (!loaded) return;
    const m = mapOf(col);
    const snap = { docs: [...m].map(([id, d]) => ({ id, data: () => d, exists: true })), size: m.size, empty: !m.size };
    (subs[col] || new Set()).forEach(s => { try { s.cb(snap) } catch (e) { console.error(e) } });
  }
  const emitAll = () => Object.keys(subs).forEach(emit);

  async function loadAll() {
    const sid = ME.member.school_id, rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('ecole_docs').select('col,id,data').eq('school_id', sid)
        .order('col').order('id').range(from, from + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    const fresh = {};
    for (const r of rows) (fresh[r.col] = fresh[r.col] || new Map()).set(r.id, r.data);
    for (const col of new Set([...Object.keys(cache), ...Object.keys(fresh)])) {
      const m = fresh[col] || new Map();
      // ne pas écraser une écriture locale encore en cours
      for (const [id, d] of mapOf(col)) if (pending[col + '/' + id]) m.set(id, d);
      cache[col] = m;
    }
    loaded = true;
    emitAll();
  }

  function listen() {
    const sid = ME.member.school_id;
    let first = true;
    channel = sb.channel('ecole-' + sid)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ecole_docs', filter: 'school_id=eq.' + sid }, p => {
        const row = p.eventType === 'DELETE' ? p.old : p.new;
        if (!row || !row.col) return;
        if (pending[row.col + '/' + row.id]) return;
        if (p.eventType === 'DELETE') mapOf(row.col).delete(row.id);
        else mapOf(row.col).set(row.id, row.data);
        emit(row.col);
      })
      .subscribe(st => {
        if (st === 'SUBSCRIBED') { if (!first) loadAll().catch(() => {}); first = false; }
      });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (ME && loaded && hiddenAt && Date.now() - hiddenAt > 45000) loadAll().catch(() => {});
  });

  const errCode = e => ({ code: e && (e.code === '42501' || /row-level security|permission/i.test(e.message || '')) ? 'permission_denied' : 'unavailable', message: e && e.message });
  const rid = () => { const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', b = crypto.getRandomValues(new Uint8Array(20)); return [...b].map(x => a[x % 62]).join(''); };

  function docRef(col, id) {
    const key = () => col + '/' + id;
    return {
      id,
      async set(data) {
        const m = mapOf(col), had = m.has(id), prev = m.get(id);
        const clean = JSON.parse(JSON.stringify(data ?? {}));
        m.set(id, clean); pending[key()] = (pending[key()] || 0) + 1; emit(col);
        try {
          const { data: out, error } = await sb.from('ecole_docs')
            .upsert({ school_id: ME.member.school_id, col, id, data: clean, updated_by: ME.uid })
            .select('data').maybeSingle();
          if (error) throw error;
          if (out && pending[key()] === 1) m.set(id, out.data);
        } catch (e) {
          if (pending[key()] === 1) { had ? m.set(id, prev) : m.delete(id); }
          throw errCode(e);
        } finally { pending[key()]--; if (!pending[key()]) delete pending[key()]; emit(col); }
      },
      async get() { const d = mapOf(col).get(id); return { id, exists: d !== undefined, data: () => d }; },
      async delete() {
        const m = mapOf(col), had = m.has(id), prev = m.get(id);
        m.delete(id); pending[key()] = (pending[key()] || 0) + 1; emit(col);
        try {
          const { error } = await sb.from('ecole_docs').delete().eq('school_id', ME.member.school_id).eq('col', col).eq('id', id);
          if (error) throw error;
        } catch (e) { if (had) m.set(id, prev); throw errCode(e); }
        finally { pending[key()]--; if (!pending[key()]) delete pending[key()]; emit(col); }
      }
    };
  }

  const db = {
    collection(col) {
      return {
        doc: id => docRef(col, id || rid()),
        onSnapshot(cb, err) {
          const s = { cb, err }; (subs[col] = subs[col] || new Set()).add(s);
          if (loaded) setTimeout(() => emit(col), 0);
          return () => subs[col].delete(s);
        }
      };
    }
  };

  const user = {
    id: async () => ME.uid,
    canEdit: async () => ME.member.role === 'admin',
    name: async () => ME.member.nom || ''
  };

  /* ---------- Assistant IA (Gemini, via la fonction « ecole-ia ») ---------- */
  async function askIA(prompt, asJson, opts) {
    const signal = opts && opts.signal;
    if (signal && signal.aborted) throw { code: 'cancelled' };
    const call = sb.functions.invoke('ecole-ia', { body: { prompt: String(prompt), json: !!asJson } });
    const res = await (signal ? Promise.race([call, new Promise((_, ko) => signal.addEventListener('abort', () => ko({ code: 'cancelled' })))]) : call);
    if (res.error) {
      let code = 'unavailable';
      try { const j = await res.error.context.json(); code = j.code || code; } catch (e) {}
      throw { code };
    }
    return String(res.data && res.data.text || '');
  }
  function parseJSON(t) {
    const s = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(s); } catch (e) {}
    const m = s.match(/[\[{][\s\S]*[\]}]/);
    if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
    return [s];
  }
  const sample = {
    text: (p, o) => askIA(p, false, o),
    json: async (p, o) => parseJSON(await askIA(p, true, o))
  };

  /* ---------- Téléchargements : partage direct (WhatsApp…) ou enregistrement ---------- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const file = new File([blob], filename, { type: blob.type || 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: filename }); return; }
        catch (e) { if (e && e.name === 'AbortError') throw { code: 'declined' }; }
      }
      const url = URL.createObjectURL(file), a = document.createElement('a');
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  };

  const API = { db, user, sample, downloads };
  window.claude = { use: name => API[name] ? ready.then(() => API[name]) : Promise.reject({ code: 'not_available' }) };

  /* ---------- Écran de connexion ---------- */
  const css = `
  #auth{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:20px;overflow:auto;
    background:radial-gradient(circle at 25% 15%,#921733 0%,#5c0f21 40%,#14030a 100%);color:#fff;font-family:Outfit,system-ui,sans-serif}
  #auth[hidden]{display:none!important}
  #auth .box{width:100%;max-width:380px;display:flex;flex-direction:column;gap:14px}
  #auth .lg{width:92px;height:92px;border-radius:28px;margin:0 auto 4px;box-shadow:0 12px 30px rgba(0,0,0,.4)}
  #auth h1{font-family:Anton,Impact,sans-serif;font-weight:400;font-size:30px;letter-spacing:.5px;margin:0;text-align:center}
  #auth p{margin:0;text-align:center;color:rgba(255,255,255,.78);font-size:14.5px;line-height:1.45}
  #auth .tabs{display:grid;grid-template-columns:1fr 1fr;background:rgba(0,0,0,.28);border-radius:16px;padding:4px}
  #auth .tabs button{border:0;background:none;color:#fff;font:600 14.5px Outfit,sans-serif;padding:11px;border-radius:12px;cursor:pointer}
  #auth .tabs button.on{background:#fff;color:#5c0f21}
  #auth form{display:flex;flex-direction:column;gap:11px}
  #auth label{font-size:13px;font-weight:600;color:rgba(255,255,255,.8);display:flex;flex-direction:column;gap:6px}
  #auth input{font:500 17px Outfit,sans-serif;padding:14px 15px;border-radius:14px;border:1.5px solid rgba(255,255,255,.22);background:rgba(0,0,0,.25);color:#fff;outline:none;width:100%;box-sizing:border-box}
  #auth input:focus{border-color:#fff}
  #auth input.code{letter-spacing:.45em;text-align:center;font-weight:800;font-size:22px}
  #auth .go{border:0;border-radius:16px;padding:15px;font:700 16px Outfit,sans-serif;background:#fff;color:#5c0f21;cursor:pointer;margin-top:4px}
  #auth .go:disabled{opacity:.6}
  #auth .msg{min-height:20px;font-size:14px;text-align:center;color:#ffd0d8}
  #auth .msg.ok{color:#bff0d3}
  #auth .lnk{background:none;border:0;color:#fff;text-decoration:underline;font:500 14px Outfit,sans-serif;cursor:pointer;padding:6px}
  #auth .note{font-size:12.5px;color:rgba(255,255,255,.6);text-align:center}
  .clr-acc{display:flex;align-items:center;gap:12px;margin:18px 0 6px;padding:14px 16px;border-radius:18px;background:var(--surface,#22060f);border:1px solid var(--line,#3d0e1d);color:var(--ink,#fff);font-family:var(--f-b,Outfit,sans-serif)}
  .clr-acc span{flex:1;min-width:0;font-size:14px;line-height:1.35}.clr-acc small{display:block;color:var(--muted,rgba(255,255,255,.7))}
  .clr-acc button{border:1px solid var(--line,#3d0e1d);background:transparent;color:inherit;font:600 14px var(--f-b,Outfit,sans-serif);padding:10px 14px;border-radius:12px;cursor:pointer}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const box = document.createElement('div'); box.id = 'auth'; box.hidden = true;
  box.innerHTML = `<div class="box">
    <img class="lg" src="icon-192.png" alt="">
    <h1>Collège La Rivière</h1>
    <p id="a-sub">Connectez-vous avec votre numéro de téléphone.</p>
    <div class="tabs" role="tablist"><button type="button" data-t="in" class="on">Se connecter</button><button type="button" data-t="up">Première fois</button></div>
    <form id="a-in" autocomplete="on">
      <label>Numéro de téléphone<input name="tel" type="tel" inputmode="tel" autocomplete="username" placeholder="08x xxx xxxx" required></label>
      <label>Mot de passe<input name="pw" type="password" autocomplete="current-password" required></label>
      <button class="go" type="submit">Se connecter</button>
      <button class="lnk" type="button" data-t="up">Mot de passe oublié ?</button>
    </form>
    <form id="a-up" hidden>
      <p>Utilisez le code personnel à 4 chiffres donné par la direction. Il relie ce téléphone à votre profil.</p>
      <label>Code de l’école<input name="school" autocapitalize="characters" required value="${(CFG.schoolCode || '').replace(/"/g, '')}"></label>
      <label>Code personnel (4 chiffres)<input class="code" name="code" inputmode="numeric" maxlength="4" pattern="[0-9]{4}" autocomplete="one-time-code" required></label>
      <label>Numéro de téléphone<input name="tel" type="tel" inputmode="tel" autocomplete="username" placeholder="08x xxx xxxx" required></label>
      <label>Choisissez un mot de passe<input name="pw" type="password" autocomplete="new-password" minlength="6" required></label>
      <button class="go" type="submit">Créer mon accès</button>
      <p class="note">Mot de passe oublié : refaites cette étape avec le même téléphone et votre code ; le nouveau mot de passe remplace l’ancien.</p>
    </form>
    <div class="msg" id="a-msg" role="status"></div>
  </div>`;
  const mount = () => document.body.appendChild(box);
  document.body ? mount() : document.addEventListener('DOMContentLoaded', mount);
  const $a = s => box.querySelector(s);
  const msg = (t, ok) => { const m = $a('#a-msg'); m.textContent = t || ''; m.className = 'msg' + (ok ? ' ok' : ''); };
  function tab(t) {
    box.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
    $a('#a-in').hidden = t !== 'in'; $a('#a-up').hidden = t !== 'up';
    $a('#a-sub').textContent = t === 'in' ? 'Connectez-vous avec votre numéro de téléphone.' : 'Créer votre accès (ou changer de mot de passe).';
    msg('');
  }
  box.addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) tab(b.dataset.t); });
  const busy = (f, on) => { const b = f.querySelector('.go'); b.disabled = on; };

  $a('#a-in').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target; const tel = normPhone(f.tel.value);
    if (tel.length < 11) return msg('Numéro de téléphone invalide.');
    busy(f, true); msg('Connexion…', true);
    const { error } = await sb.auth.signInWithPassword({ email: emailOf(tel), password: f.pw.value });
    busy(f, false);
    if (error) return msg(/invalid/i.test(error.message) ? 'Téléphone ou mot de passe incorrect.' : 'Connexion impossible. Vérifiez internet.');
    msg(''); start();
  });
  $a('#a-up').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target; const tel = normPhone(f.tel.value);
    if (tel.length < 11) return msg('Numéro de téléphone invalide.');
    busy(f, true); msg('Vérification du code…', true);
    let out = {};
    try {
      const r = await fetch(CFG.url + '/functions/v1/ecole-compte', {
        method: 'POST', headers: { 'content-type': 'application/json', apikey: CFG.anonKey, authorization: 'Bearer ' + CFG.anonKey },
        body: JSON.stringify({ school: f.school.value, code: f.code.value, phone: tel, password: f.pw.value })
      });
      out = await r.json().catch(() => ({}));
      if (!r.ok) { busy(f, false); return msg(out.error || 'Création impossible. Réessayez.'); }
    } catch (err) { busy(f, false); return msg('Pas de connexion internet.'); }
    const { error } = await sb.auth.signInWithPassword({ email: out.email || emailOf(tel), password: f.pw.value });
    busy(f, false);
    if (error) return msg('Accès créé, mais la connexion a échoué. Touchez « Se connecter ».');
    msg(''); start();
  });

  async function start() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { box.hidden = false; return; }
    const { data: member, error } = await sb.from('ecole_members').select('*').eq('user_id', session.user.id).maybeSingle();
    if (error) {
      box.hidden = false;
      return msg(/does not exist|relation/i.test(error.message) ? 'La base de données de l’école n’est pas encore installée.' : 'Connexion au serveur impossible. Vérifiez internet puis rouvrez l’application.');
    }
    if (!member) { await sb.auth.signOut(); box.hidden = false; tab('up'); return msg('Ce compte n’est relié à aucun profil. Utilisez votre code personnel.'); }
    if (ME) return;
    ME = { uid: session.user.id, member, phone: session.user.email.split('@')[0] };
    box.hidden = true;
    try { await loadAll(); } catch (e) { loaded = true; emitAll(); }
    listen();
    readyResolve();
  }

  window.appLogout = async () => {
    try { if (channel) await sb.removeChannel(channel); } catch (e) {}
    await sb.auth.signOut();
    try { localStorage.removeItem('clr-intro'); } catch (e) {}
    location.reload();
  };

  /* Bloc « Mon compte » ajouté dans Gestion (direction) et sur le profil (enseignant) */
  function accountBlock() {
    if (!ME) return;
    const inS = typeof S !== 'undefined';
    const host = (inS && S.view === 'gestion' && document.querySelector('[data-act="go"][data-v="presence"]')?.parentElement)
      || (inS && S.view === 'prof' && (S.pid === ME.member.profile_id || S.pid === ME.uid) && document.querySelector('.pf-page .prof'));
    if (!host || host.querySelector(':scope > .clr-acc')) return;
    const d = document.createElement('div'); d.className = 'clr-acc';
    const tel = '+' + ME.phone;
    d.innerHTML = `<span><b>${(ME.member.nom || 'Mon compte').replace(/[<>&]/g, '')}</b><small>Connecté avec ${tel} · ${ME.member.role === 'admin' ? 'Direction' : 'Enseignant'}</small></span><button type="button">Se déconnecter</button>`;
    d.querySelector('button').onclick = () => window.appLogout();
    host.appendChild(d);
  }
  addEventListener('load', () => {
    if (typeof window.render === 'function') {
      const r = window.render;
      window.render = function () { const out = r.apply(this, arguments); try { accountBlock(); } catch (e) {} return out; };
    }
  });

  sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT' && ME) location.reload(); });
  start().catch(() => { box.hidden = false; msg('Connexion au serveur impossible. Vérifiez internet.'); });
})();
