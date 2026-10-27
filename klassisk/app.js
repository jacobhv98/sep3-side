// SEP3 projektstyring: læser og skriver opgaver (GitHub Issues) og viser repoets filer.
// Al data ligger i GitHub; siden er kun en visning, så intet går tabt, hvis siden forsvinder.

const REPO = 'jacobhv98/sep3';
const GREN = 'main';
const API = 'https://api.github.com';
const LABEL_I_GANG = 'status:i-gang';
const LABEL_BESLUTNING = 'type:beslutning';

// ---------- Token (gemmes kun i denne browser) ----------

function hentToken() {
  try { return localStorage.getItem('sep3-token') || ''; } catch { return ''; }
}
function gemToken(token) {
  try {
    if (token) localStorage.setItem('sep3-token', token);
    else localStorage.removeItem('sep3-token');
  } catch { /* privat vindue: tokenet gælder kun denne fane */ }
  sessionToken = token;
}
let sessionToken = hentToken();

// ---------- GitHub API ----------

// raa: returnér filindholdet som Blob. tom404: returnér data = null i stedet for at fejle, når stien ikke findes.
// En fejl har .status, så kalderen kan genkende konflikter (409/422).
async function api(sti, { metode = 'GET', data, raa = false, tom404 = false } = {}) {
  const headers = { Accept: raa ? 'application/vnd.github.raw' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  if (data) headers['Content-Type'] = 'application/json';
  const svar = await fetch(sti.startsWith('http') ? sti : API + sti, {
    method: metode, headers, body: data ? JSON.stringify(data) : undefined, cache: 'no-store',
  });
  if (tom404 && svar.status === 404) return { data: null, link: null };
  if (!svar.ok) {
    const tekst = await svar.text();
    if (svar.status === 409 || svar.status === 422) {
      let grund = tekst.slice(0, 200);
      try { grund = JSON.parse(tekst).message || grund; } catch { /* ikke JSON: brug teksten som den er */ }
      throw Object.assign(new Error(`GitHub afviste ændringen (${svar.status}): ${grund}. Intet er gemt. Tjek felterne og dit token, og prøv igen.`), { status: svar.status });
    }
    if (svar.status === 401 || svar.status === 404) {
      throw new Error(sessionToken
        ? `GitHub afviste tokenet (${svar.status}). Tjek at det har adgang til ${REPO}.`
        : 'Log ind med et GitHub-token for at se projektet.');
    }
    throw new Error(`GitHub-fejl ${svar.status}: ${tekst.slice(0, 200)}`);
  }
  if (raa) return { data: await svar.blob(), link: null };
  return { data: svar.status === 204 ? null : await svar.json(), link: svar.headers.get('Link') };
}

let mitLogin = null;
async function hentMitLogin() {
  mitLogin ??= (await api('/user')).data.login;
  return mitLogin;
}

// Henter alle sider af et listeendpoint (GitHub giver højst 100 pr. side).
async function hentAlle(sti) {
  const alle = [];
  let naeste = sti + (sti.includes('?') ? '&' : '?') + 'per_page=100';
  while (naeste) {
    const { data, link } = await api(naeste);
    alle.push(...data);
    naeste = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }
  return alle;
}

// ---------- Hjælpere ----------

const $ = (sel, rod = document) => rod.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dato = (iso) => new Date(iso).toLocaleString('da-DK', { dateStyle: 'short', timeStyle: 'short' });
const labels = (issue) => issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
const EMNE_NAVNE = { 'emne:koncept': 'Koncept', 'emne:tegning': 'Tegning', 'emne:beregning': 'Beregning', 'emne:rapport': 'Rapport', 'emne:moede': 'Møde' };
const initialer = (login) => login.slice(0, 2).toUpperCase();

// Ikoner: egne SVG'er i én stregtykkelse.
const IKON = {
  mappe: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  fil: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
  laas: '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  commit: '<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>',
  opgave: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
};
const ikon = (navn) => `<svg class="ik" viewBox="0 0 24 24" aria-hidden="true">${IKON[navn]}</svg>`;

function visFejl(fejl) {
  const boks = $('#besked');
  boks.textContent = fejl ? fejl.message || String(fejl) : '';
  boks.hidden = !fejl;
}

// Kører en handling og genindlæser bagefter; fejl vises i stedet for at forsvinde stille.
async function udfoer(handling) {
  try {
    visFejl(null);
    await handling();
    await indlaesAktivFane();
  } catch (fejl) {
    visFejl(fejl);
  }
}

// ---------- Status ----------

// Afgør hvilken kolonne en opgave hører til: 'todo', 'i-gang' eller 'udfoert'.
// issue.state er 'open' eller 'closed'; issue.state_reason er 'completed', 'not_planned' eller 'reopened'.
function statusFor(issue) {
  // TODO (gruppens beslutning): hvad skal der ske med
  //   1) en opgave lukket som "not planned" (droppet): er den udført, eller skal den skjules?
  //   2) en lukket opgave, der stadig har labelen status:i-gang?
  // Basisreglen herunder virker, men tager ikke stilling til de to tilfælde.
  if (issue.state === 'closed') return 'udfoert';
  if (labels(issue).includes(LABEL_I_GANG)) return 'i-gang';
  return 'todo';
}

// ---------- Opgaver ----------

async function indlaesOpgaver() {
  const issues = (await hentAlle(`/repos/${REPO}/issues?state=all`))
    .filter((i) => !i.pull_request && !labels(i).includes(LABEL_BESLUTNING));

  const tavle = $('.tavle');
  if (!tavle.dataset.set) {   // tagsene glider kun ind ved første indlæsning, ikke efter hver handling
    tavle.dataset.set = '1';
    tavle.dataset.foerste = 'ja';
    setTimeout(() => delete tavle.dataset.foerste, 900);
  }
  document.querySelectorAll('.kolonne ul').forEach((ul) => (ul.innerHTML = ''));
  const antal = { todo: 0, 'i-gang': 0, udfoert: 0 };
  for (const issue of issues) {
    const status = statusFor(issue);
    if (!status) continue;
    antal[status]++;
    const ul = $(`.kolonne[data-status="${status}"] ul`);
    const klasse = { todo: 'todo', 'i-gang': 'go', udfoert: 'done' }[status];
    const emner = labels(issue).filter((l) => l.startsWith('emne:')).map((l) => EMNE_NAVNE[l] || l.replace('emne:', ''));
    const login = issue.assignee?.login;
    ul.insertAdjacentHTML('beforeend', `
      <li class="kort ${klasse}" data-nr="${issue.number}">
        <div class="kort-hoved"><span class="nr">#${issue.number}</span><a class="titel" href="${issue.html_url}" target="_blank" rel="noopener">${esc(issue.title)}</a></div>
        <div class="meta">${emner.map((e) => `<span class="emne">${esc(e)}</span>`).join('')}${login ? `<span class="hvem" aria-hidden="true">${esc(initialer(login))}</span><span class="login">${esc(login)}</span>` : ''}<span class="komm">${issue.comments} ${issue.comments === 1 ? 'kommentar' : 'kommentarer'}</span></div>
        <div class="handlinger">
          ${status === 'todo' ? '<button data-handling="start">Start</button>' : ''}
          ${status !== 'udfoert' ? '<button data-handling="udfoert">Udført</button>' : '<button data-handling="genaabn" class="sekundaer">Genåbn</button>'}
          <button data-handling="kommenter" class="sekundaer">Kommentér</button>
        </div>
      </li>`);
  }
  for (const [status, n] of Object.entries(antal)) {
    $(`.kolonne[data-status="${status}"] .antal`).textContent = n;
    $(`#lamper .lampe[data-status="${status}"] b`).textContent = n;
  }
}

const opgaveHandlinger = {
  start: async (nr) => {
    // Den, der starter opgaven, bliver ansvarlig, så "hvem arbejder på hvad" kan besvares.
    const { data: mig } = await api('/user');
    await api(`/repos/${REPO}/issues/${nr}/assignees`, { metode: 'POST', data: { assignees: [mig.login] } });
    await api(`/repos/${REPO}/issues/${nr}/labels`, { metode: 'POST', data: { labels: [LABEL_I_GANG] } });
  },
  udfoert: async (nr) => {
    // Lukning er reversibel og bevarer historikken; opgaver slettes aldrig fra siden.
    await api(`/repos/${REPO}/issues/${nr}`, { metode: 'PATCH', data: { state: 'closed', state_reason: 'completed' } });
    await api(`/repos/${REPO}/issues/${nr}/labels/${encodeURIComponent(LABEL_I_GANG)}`, { metode: 'DELETE' }).catch(() => {});
  },
  genaabn: (nr) => api(`/repos/${REPO}/issues/${nr}`, { metode: 'PATCH', data: { state: 'open' } }),
  kommenter: (nr) => {
    const tekst = prompt(`Kommentar til #${nr}:`);
    if (tekst) return api(`/repos/${REPO}/issues/${nr}/comments`, { metode: 'POST', data: { body: tekst } });
  },
};

// ---------- Filer ----------
// Siden læser repoets filer direkte fra GitHub og skriver tilbage som almindelige commits,
// så hver rettelse og upload ligger i git-historikken og kan rulles tilbage.

const LAASEFIL = 'Github Filer/data/laase.json';
const TEKSTFIL = /\.(md|txt|csv|tsv|json|m|py|js|mjs|ts|css|html|xml|yml|yaml|tex|bib|ini|toml)$/i;
const BILLEDE = /\.(png|jpe?g|gif|svg|webp|bmp)$/i;
// Samme filtyper som "binary" i .gitattributes: git kan ikke flette dem, så de skal låses før redigering.
const KAN_IKKE_FLETTES = /\.(docx|xlsx|pptx|pdf|png|jpe?g|ipt|iam|idw|dwg|step|stp|f3d)$/i;
const MAX_UPLOAD = 95 * 1024 * 1024;   // GitHub afviser filer over 100 MB

let alleFiler = [];
let laase = {};
let laaseSha = null;
let valgtSti = null;

const kodetSti = (sti) => sti.split('/').map(encodeURIComponent).join('/');
const mappeAf = (sti) => sti.includes('/') ? sti.slice(0, sti.lastIndexOf('/')) : '';

function tilBase64(bytes) {
  let binaer = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binaer += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binaer);
}
const fraBase64Tekst = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), (c) => c.charCodeAt(0)));

async function indlaesFiler() {
  if (!alleFiler.length) {
    const { data } = await api(`/repos/${REPO}/git/trees/${GREN}?recursive=1`);
    alleFiler = data.tree.filter((t) => t.type === 'blob').map((t) => t.path);
  }
  await indlaesLaase();
  await fyldOpgaveVaelgere();
  tegnFiltrae($('#filsoeg').value.trim().toLowerCase());
}

async function indlaesLaase() {
  const { data } = await api(`/repos/${REPO}/contents/${kodetSti(LAASEFIL)}?ref=${GREN}`, { tom404: true });
  laase = data ? JSON.parse(fraBase64Tekst(data.content)) : {};
  laaseSha = data?.sha ?? null;
}

// Opgave-vælgeren er påkrævet ved gem og upload, så hver ændring kan spores til en opgave (#nr i commit-beskeden).
async function fyldOpgaveVaelgere() {
  const aabne = (await hentAlle(`/repos/${REPO}/issues?state=open`)).filter((i) => !i.pull_request);
  const valg = '<option value="">Vælg opgave …</option>' +
    aabne.map((i) => `<option value="${i.number}">#${i.number} ${esc(i.title)}</option>`).join('');
  document.querySelectorAll('select.opgavevalg').forEach((s) => {
    const tidligere = s.value;
    s.innerHTML = valg;
    s.value = tidligere;
  });
}

function tegnFiltrae(soeg) {
  const rod = {};
  for (const sti of alleFiler) {
    if (soeg && !sti.toLowerCase().includes(soeg)) continue;
    let node = rod;
    for (const del of sti.split('/')) node = node[del] ??= {};
    node.__sti = sti;
  }
  const tegn = (node, sti) => Object.keys(node).filter((k) => k !== '__sti').sort().map((navn) => {
    const barn = node[navn];
    if (barn.__sti) {
      const laas = laase[barn.__sti];
      return `<li data-sti="${esc(barn.__sti)}" class="${barn.__sti === valgtSti ? 'valgt' : ''}">${ikon('fil')}<span>${esc(navn)}</span>${laas ? `<span class="laas" title="Låst af ${esc(laas.login)}">${ikon('laas')}${esc(laas.navn || laas.login)}</span>` : ''}</li>`;
    }
    const mappe = sti ? `${sti}/${navn}` : navn;
    return `<li><details${soeg ? ' open' : ''}><summary data-mappe="${esc(mappe)}">${ikon('mappe')}${esc(navn)}</summary><ul>${tegn(barn, mappe)}</ul></details></li>`;
  }).join('');
  $('#filtrae').innerHTML = tegn(rod, '') || '<li class="svag">Ingen filer matcher.</li>';
}

// ----- Visning -----

async function visFil(sti, ref = GREN) {
  valgtSti = sti;
  if (sessionToken) await hentMitLogin();
  $('#upload [name=mappe]').value = mappeAf(sti);
  tegnFiltrae($('#filsoeg').value.trim().toLowerCase());
  const panel = $('#fildetaljer');
  panel.innerHTML = '<p class="svag">Henter …</p>';

  const [{ data: commits }, { data: indhold }] = await Promise.all([
    api(`/repos/${REPO}/commits?sha=${GREN}&path=${encodeURIComponent(sti)}&per_page=15`),
    api(`/repos/${REPO}/contents/${kodetSti(sti)}?ref=${encodeURIComponent(ref)}`, { raa: true }),
  ]);
  // Opgaver kobles til filer via "#12" i commit-beskeden.
  const opgaver = [...new Set(commits.flatMap((c) => [...c.commit.message.matchAll(/#(\d+)/g)].map((m) => m[1])))];
  const laas = laase[sti];
  const egenLaas = laas && laas.login === mitLogin;
  const gammelVersion = ref !== GREN;
  const navn = sti.split('/').pop();
  const blobUrl = URL.createObjectURL(indhold);

  panel.innerHTML = `
    <h3>${esc(navn)}</h3>
    <p class="svag">${esc(sti)} · ${(indhold.size / 1024).toFixed(1)} kB${gammelVersion ? ` · <b>version ${esc(ref.slice(0, 7))}</b> <a href="#" data-handling="nyeste">vis nyeste</a>` : ''}</p>
    ${laas && !egenLaas ? `<p class="laasbanner">${ikon('laas')}<span>Låst af <b>${esc(laas.navn || laas.login)}</b> siden ${dato(laas.siden)}${laas.opgave ? ` (opgave #${esc(laas.opgave)})` : ''}. Ret ikke filen, før den er frigivet.</span></p>` : ''}
    ${egenLaas ? `<p class="laasbanner egen">${ikon('laas')}<span>Du har låst filen siden ${dato(laas.siden)}. Upload din nye version, og frigiv derefter låsen.</span></p>` : ''}
    <div class="filknapper">
      <a class="knap" href="${blobUrl}" download="${esc(navn)}">Download</a>
      <a class="knap sekundaer" href="https://github.com/${REPO}/blob/${GREN}/${kodetSti(sti)}" target="_blank" rel="noopener">Åbn på GitHub</a>
      ${!gammelVersion && TEKSTFIL.test(sti) && (!laas || egenLaas) ? '<button data-handling="ret">Ret</button>' : ''}
      ${!gammelVersion && KAN_IKKE_FLETTES.test(sti) && !laas ? '<button data-handling="laas" class="sekundaer">Lås fil (jeg redigerer)</button>' : ''}
      ${egenLaas ? '<button data-handling="frigiv" class="sekundaer">Frigiv lås</button>' : ''}
    </div>
    <div id="filindhold"></div>
    <h4>Tilknyttede opgaver</h4>
    <p>${opgaver.length ? opgaver.map((n) => `<a href="https://github.com/${REPO}/issues/${n}" target="_blank" rel="noopener">#${n}</a>`).join(' ') : '<span class="svag">Ingen. Skriv #nummer i commit-beskeden.</span>'}</p>
    <h4>Historik</h4>
    <ul class="liste">${commits.map((c) => `<li>${esc(c.commit.message.split('\n')[0])}<br><span class="svag">${esc(c.author?.login || c.commit.author.name)} · ${dato(c.commit.author.date)} · <a href="#" data-handling="version" data-sha="${c.sha}">vis denne version</a></span></li>`).join('')}</ul>`;

  const felt = $('#filindhold');
  if (sti.toLowerCase().endsWith('.md')) {
    felt.className = 'markdown';
    felt.innerHTML = renderMarkdown(await indhold.text());
    await hentRelativeBilleder(felt, mappeAf(sti), ref);
    window.MathJax?.typesetPromise?.([felt]);
  } else if (BILLEDE.test(sti)) {
    felt.className = '';
    felt.innerHTML = `<img src="${blobUrl}" alt="${esc(navn)}">`;
  } else if (/\.pdf$/i.test(sti)) {
    felt.className = '';
    felt.innerHTML = `<iframe src="${URL.createObjectURL(new Blob([indhold], { type: 'application/pdf' }))}" title="${esc(navn)}"></iframe>`;
  } else if (TEKSTFIL.test(sti) && indhold.size < 2 * 1024 * 1024) {
    felt.className = '';
    felt.innerHTML = `<pre>${esc(await indhold.text())}</pre>`;
  } else {
    felt.className = '';
    felt.innerHTML = '<p class="svag">Filen kan ikke vises i browseren. Download den, eller åbn den på GitHub.</p>';
  }
}

// Markdown med LaTeX: matematikken tages ud før marked (som ellers ødelægger _ og \), og sættes ind igen bagefter.
function renderMarkdown(tekst) {
  if (!window.marked) return `<pre>${esc(tekst)}</pre>`;
  const matematik = [];
  const beskyttet = tekst
    .replace(/\$\$[\s\S]+?\$\$/g, (m) => `\u0000M${matematik.push(m) - 1}\u0000`)
    .replace(/(?<![\\$])\$(?!\s)[^$\n]+?(?<!\s)\$/g, (m) => `\u0000M${matematik.push(m) - 1}\u0000`)
    .replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (_, fil) => `![${fil}](${encodeURI(fil)})`)   // Obsidian-billeder
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, _maal, alias) => alias || _maal);        // Obsidian-links som tekst
  const html = marked.parse(beskyttet).replace(/\u0000M(\d+)\u0000/g, (_, i) => esc(matematik[i]));
  return window.DOMPurify ? DOMPurify.sanitize(html) : esc(tekst);
}

// Relative billedstier i Markdown peger ind i et privat repo, så de hentes med tokenet og vises som blob-URL.
async function hentRelativeBilleder(felt, mappe, ref) {
  await Promise.all([...felt.querySelectorAll('img')].map(async (img) => {
    const src = img.getAttribute('src');
    if (!src || /^(https?:|data:|blob:)/.test(src)) return;
    let sti = decodeURI(src);
    if (!alleFiler.includes(sti)) sti = [mappe, sti].filter(Boolean).join('/');
    if (!alleFiler.includes(sti)) sti = alleFiler.find((f) => f.endsWith('/' + decodeURI(src))) ?? sti;   // Obsidian finder billeder på navn
    try {
      const { data } = await api(`/repos/${REPO}/contents/${kodetSti(sti)}?ref=${encodeURIComponent(ref)}`, { raa: true });
      img.src = URL.createObjectURL(data);
    } catch { img.alt = `(billedet ${src} blev ikke fundet)`; }
  }));
}

// ----- Ret tekstfil -----

async function visEditor(sti) {
  const { data } = await api(`/repos/${REPO}/contents/${kodetSti(sti)}?ref=${GREN}`);
  const felt = $('#filindhold');
  felt.className = '';
  felt.innerHTML = `
    <form id="ret-fil" class="editor">
      <textarea name="tekst" spellcheck="false"></textarea>
      ${sti.toLowerCase().endsWith('.md') ? '<details><summary>Forhåndsvisning</summary><div class="markdown" id="forhaand"></div></details>' : ''}
      <select name="opgave" class="opgavevalg" required></select>
      <input name="besked" placeholder="Hvad har du ændret?" required>
      <button>Gem som commit</button>
      <button type="button" class="sekundaer" data-handling="annuller">Annuller</button>
    </form>`;
  const form = $('#ret-fil');
  form.tekst.value = fraBase64Tekst(data.content);
  form.dataset.sha = data.sha;
  form.dataset.sti = sti;
  await fyldOpgaveVaelgere();
  $('#forhaand') && form.querySelector('details').addEventListener('toggle', (e) => {
    if (e.target.open) { $('#forhaand').innerHTML = renderMarkdown(form.tekst.value); window.MathJax?.typesetPromise?.([$('#forhaand')]); }
  });
}

async function gemTekstfil(form) {
  const sti = form.dataset.sti;
  try {
    await api(`/repos/${REPO}/contents/${kodetSti(sti)}`, {
      metode: 'PUT',
      data: {
        message: `#${form.opgave.value} ${form.besked.value}`,
        content: tilBase64(new TextEncoder().encode(form.tekst.value)),
        sha: form.dataset.sha,   // GitHub afviser, hvis filen er ændret siden; så overskrives ingens arbejde
        branch: GREN,
      },
    });
  } catch (fejl) {
    if (fejl.status === 409 || fejl.status === 422) {
      throw new Error('Filen er ændret af en anden, mens du rettede. Kopiér din tekst, genindlæs filen og indsæt dine ændringer igen. Intet er overskrevet.');
    }
    throw fejl;
  }
  await visFil(sti);
}

// ----- Upload (én commit for alle filer, via Git Data API) -----

async function uploadFiler(filer, mappe, opgave, besked) {
  const login = await hentMitLogin();
  await indlaesLaase();
  for (const fil of filer) {
    const sti = [mappe.replace(/^\/+|\/+$/g, ''), fil.name].filter(Boolean).join('/');
    if (fil.size > MAX_UPLOAD) throw new Error(`${fil.name} er over 95 MB, og GitHub afviser den. Læg den på OneDrive/Teams og upload en tekstfil med linket.`);
    const laas = laase[sti];
    if (laas && laas.login !== login) throw new Error(`${sti} er låst af ${laas.navn || laas.login}. Upload ikke en ny version, før den er frigivet.`);
    if (alleFiler.includes(sti) && KAN_IKKE_FLETTES.test(sti) && !laas) throw new Error(`${sti} findes allerede og kan ikke flettes. Lås filen først, så ingen andre retter den samtidig.`);
  }
  const elementer = [];
  for (const fil of filer) {
    const sti = [mappe.replace(/^\/+|\/+$/g, ''), fil.name].filter(Boolean).join('/');
    const { data: blob } = await api(`/repos/${REPO}/git/blobs`, {
      metode: 'POST', data: { content: tilBase64(new Uint8Array(await fil.arrayBuffer())), encoding: 'base64' },
    });
    elementer.push({ path: sti, mode: '100644', type: 'blob', sha: blob.sha });
  }
  await commitTrae(elementer, `#${opgave} ${besked}`);
  alleFiler = [];
}

// Laver en commit oven på main uden force. Har en anden pushet imens, bygges commit'en igen på den nye main.
async function commitTrae(elementer, besked) {
  for (let forsoeg = 0; forsoeg < 3; forsoeg++) {
    const { data: ref } = await api(`/repos/${REPO}/git/ref/heads/${GREN}`);
    const { data: forrige } = await api(`/repos/${REPO}/git/commits/${ref.object.sha}`);
    const { data: trae } = await api(`/repos/${REPO}/git/trees`, { metode: 'POST', data: { base_tree: forrige.tree.sha, tree: elementer } });
    const { data: commit } = await api(`/repos/${REPO}/git/commits`, { metode: 'POST', data: { message: besked, tree: trae.sha, parents: [ref.object.sha] } });
    try {
      await api(`/repos/${REPO}/git/refs/heads/${GREN}`, { metode: 'PATCH', data: { sha: commit.sha, force: false } });
      return;
    } catch (fejl) {
      if (fejl.status !== 422) throw fejl;
    }
  }
  throw new Error('Repoet ændrede sig under upload tre gange i træk. Prøv igen om lidt.');
}

// ----- Låse (Github Filer/data/laase.json) -----

async function skrivLaas(sti, laas) {
  const login = await hentMitLogin();
  for (let forsoeg = 0; forsoeg < 3; forsoeg++) {
    await indlaesLaase();
    const nu = laase[sti];
    if (laas && nu && nu.login !== login) throw new Error(`${sti} er allerede låst af ${nu.navn || nu.login}.`);
    if (!laas && nu && nu.login !== login) throw new Error(`Låsen tilhører ${nu.navn || nu.login}. Bed dem frigive den.`);
    const nye = { ...laase };
    if (laas) nye[sti] = { login, navn: laas.navn || login, siden: new Date().toISOString(), opgave: laas.opgave || undefined };
    else delete nye[sti];
    try {
      await api(`/repos/${REPO}/contents/${kodetSti(LAASEFIL)}`, {
        metode: 'PUT',
        data: {
          message: `${laas?.opgave ? `#${laas.opgave} ` : ''}${laas ? 'Lås' : 'Frigiv'} ${sti}`,
          content: tilBase64(new TextEncoder().encode(JSON.stringify(nye, null, 2) + '\n')),
          ...(laaseSha ? { sha: laaseSha } : {}),
          branch: GREN,
        },
      });
      return;
    } catch (fejl) {
      if (fejl.status !== 409 && fejl.status !== 422) throw fejl;
    }
  }
  throw new Error('Låsefilen blev ændret af andre samtidig. Prøv igen.');
}

$('#fildetaljer').addEventListener('click', (e) => {
  const knap = e.target.closest('[data-handling]');
  if (!knap) return;
  e.preventDefault();
  const handlinger = {
    ret: () => visEditor(valgtSti),
    annuller: () => visFil(valgtSti),
    nyeste: () => visFil(valgtSti),
    version: () => visFil(valgtSti, knap.dataset.sha),
    laas: async () => {
      const opgave = prompt('Opgavenummer, du redigerer filen til (kan være tomt):', '')?.replace('#', '');
      if (opgave === undefined) return;
      await skrivLaas(valgtSti, { opgave, navn: await hentMitLogin() });
      await indlaesFiler(); await visFil(valgtSti);
    },
    frigiv: async () => { await skrivLaas(valgtSti, null); await indlaesFiler(); await visFil(valgtSti); },
  };
  (async () => { try { visFejl(null); await handlinger[knap.dataset.handling](); } catch (fejl) { visFejl(fejl); } })();
});

$('#fildetaljer').addEventListener('submit', (e) => {
  e.preventDefault();
  (async () => { try { visFejl(null); await gemTekstfil(e.target); } catch (fejl) { visFejl(fejl); } })();
});

// Upload: vælg filer eller træk dem ind på feltet. Mappen udfyldes ud fra den valgte fil eller mappe.
const uploadForm = $('#upload');
let uploadKoe = [];
function saetUploadFiler(filer) {
  uploadKoe = [...filer];
  $('#upload .valgte').textContent = uploadKoe.length ? uploadKoe.map((f) => f.name).join(', ') : 'Træk filer hertil, eller vælg dem';
}
uploadForm.filer.addEventListener('change', () => saetUploadFiler(uploadForm.filer.files));
uploadForm.addEventListener('dragover', (e) => { e.preventDefault(); uploadForm.classList.add('over'); });
uploadForm.addEventListener('dragleave', () => uploadForm.classList.remove('over'));
uploadForm.addEventListener('drop', (e) => { e.preventDefault(); uploadForm.classList.remove('over'); saetUploadFiler(e.dataTransfer.files); });
uploadForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!uploadKoe.length) return visFejl(new Error('Vælg mindst én fil.'));
  (async () => {
    try {
      visFejl(null);
      uploadForm.querySelector('button').disabled = true;
      await uploadFiler(uploadKoe, uploadForm.mappe.value, uploadForm.opgave.value, uploadForm.besked.value);
      const foerste = [uploadForm.mappe.value.replace(/^\/+|\/+$/g, ''), uploadKoe[0].name].filter(Boolean).join('/');
      uploadForm.reset(); saetUploadFiler([]);
      await indlaesFiler(); await visFil(foerste);
    } catch (fejl) { visFejl(fejl); } finally { uploadForm.querySelector('button').disabled = false; }
  })();
});

// ---------- Aktivitet ----------

async function indlaesAktivitet() {
  let [{ data: commits }, { data: haendelser }] = await Promise.all([
    api(`/repos/${REPO}/commits?sha=${GREN}&per_page=60`),
    api(`/repos/${REPO}/issues/events?per_page=30`),
  ]);
  // Backup-workflowen committer ved hver ændring; dens commits er ikke aktivitet fra gruppen.
  commits = commits.filter((c) => c.author?.login !== 'github-actions[bot]').slice(0, 30);
  const oversaet = { closed: 'lukkede', reopened: 'genåbnede', labeled: 'tilføjede label til', assigned: 'tildelte', renamed: 'omdøbte', referenced: 'refererede' };
  const linjer = [
    ...commits.map((c) => ({ tid: c.commit.author.date, html: `<span class="linje">${ikon('commit')}<span><b>${esc(c.author?.login || c.commit.author.name)}</b> committede: ${esc(c.commit.message.split('\n')[0])}</span></span>` })),
    ...haendelser.map((h) => ({ tid: h.created_at, html: `<span class="linje">${ikon('opgave')}<span><b>${esc(h.actor?.login)}</b> ${oversaet[h.event] || esc(h.event)} <a href="${h.issue.html_url}" target="_blank" rel="noopener">#${h.issue.number} ${esc(h.issue.title)}</a>${h.label ? ` (${esc(h.label.name)})` : ''}</span></span>` })),
  ].sort((a, b) => b.tid.localeCompare(a.tid));
  $('#aktivitet .liste').innerHTML = linjer.map((l) => `<li>${l.html}<span class="svag">${dato(l.tid)}</span></li>`).join('');
}

// ---------- Beslutninger ----------

async function indlaesBeslutninger() {
  const beslutninger = await hentAlle(`/repos/${REPO}/issues?state=all&labels=${encodeURIComponent(LABEL_BESLUTNING)}`);
  $('#beslutninger .liste').innerHTML = beslutninger.map((b) => `
    <li><a href="${b.html_url}" target="_blank" rel="noopener">#${b.number} ${esc(b.title)}</a>
      <span class="svag">${esc(b.user.login)} · ${dato(b.created_at)}</span>
      ${b.body ? `<p>${esc(b.body)}</p>` : ''}</li>`).join('') || '<li class="svag">Ingen beslutninger logget endnu.</li>';
}

// ---------- Faner og hændelser ----------

const indlaesere = { opgaver: indlaesOpgaver, filer: indlaesFiler, aktivitet: indlaesAktivitet, beslutninger: indlaesBeslutninger };
let aktivFane = 'opgaver';

async function indlaesAktivFane() {
  document.body.dataset.login = sessionToken ? 'ja' : 'nej';
  if (!sessionToken) { visFejl(null); return; }   // udlogget: velkomstpladen vises i stedet for tomme kolonner
  try {
    visFejl(null);
    await indlaesere[aktivFane]();
  } catch (fejl) {
    visFejl(fejl);
  }
}

document.querySelectorAll('nav button').forEach((knap) => knap.addEventListener('click', () => {
  aktivFane = knap.dataset.tab;
  document.querySelectorAll('nav button').forEach((k) => { k.classList.toggle('aktiv', k === knap); if (k === knap) k.setAttribute('aria-current', 'page'); else k.removeAttribute('aria-current'); });
  document.querySelectorAll('.fane').forEach((f) => (f.hidden = f.id !== aktivFane));
  indlaesAktivFane();
}));

$('#opgaver .tavle').addEventListener('click', (e) => {
  const knap = e.target.closest('button[data-handling]');
  if (knap) udfoer(() => opgaveHandlinger[knap.dataset.handling](knap.closest('.kort').dataset.nr));
});

$('#ny-opgave').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  const emne = form.emne.value;
  udfoer(async () => {
    await api(`/repos/${REPO}/issues`, { metode: 'POST', data: { title: form.titel.value, labels: emne ? [emne] : [] } });
    form.reset();
  });
});

$('#ny-beslutning').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  udfoer(async () => {
    await api(`/repos/${REPO}/issues`, { metode: 'POST', data: { title: form.titel.value, body: form.begrundelse.value, labels: [LABEL_BESLUTNING] } });
    form.reset();
  });
});

$('#filsoeg').addEventListener('input', (e) => tegnFiltrae(e.target.value.trim().toLowerCase()));
$('#filtrae').addEventListener('click', (e) => {
  const mappe = e.target.closest('summary[data-mappe]');
  if (mappe) $('#upload [name=mappe]').value = mappe.dataset.mappe;
  const li = e.target.closest('li[data-sti]');
  if (li) visFil(li.dataset.sti).catch(visFejl);
});

const dialog = $('#token-dialog');
const opdaterTokenKnap = () => ($('#token-knap').textContent = sessionToken ? 'Logget ind' : 'Log ind');
$('#token-knap').addEventListener('click', () => dialog.showModal());
$('#velkommen-log-ind').addEventListener('click', () => dialog.showModal());
dialog.addEventListener('close', () => {
  if (dialog.returnValue === 'gem') gemToken(dialog.querySelector('[name=token]').value.trim());
  if (dialog.returnValue === 'log-ud') gemToken('');
  dialog.querySelector('[name=token]').value = '';
  alleFiler = [];
  mitLogin = null;
  opdaterTokenKnap();
  indlaesAktivFane();
});

opdaterTokenKnap();
indlaesAktivFane();
