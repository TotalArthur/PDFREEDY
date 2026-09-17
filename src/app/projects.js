// Cloud projects: save the PDF currently open (and reload it later, on any
// device signed into the same account) via Supabase Storage. Entirely
// opt-in — nothing here runs unless someone signs in and clicks "Save to
// cloud"; opening a PDF locally never uploads it on its own.
import { sb, CLOUD_ENABLED } from './supabaseClient.js';
import { S } from './state.js';
import { loadPdf } from './pdf.js';
import { logUsageEvent } from './usage.js';

const BUCKET = 'pdfs';

const $ = id => document.getElementById(id);
const projectsBtn = $('projectsBtn');
const projectsOverlay = $('projectsOverlay');
const projectsCloseBtn = $('projectsCloseBtn');
const projectsList = $('projectsList');
const saveProjectBtn = $('saveProjectBtn');
const projectNameInput = $('projectNameInput');
const projectsStatus = $('projectsStatus');

function setStatus(msg) { projectsStatus.textContent = msg || ''; }

async function saveCurrentAsProject() {
  if (!CLOUD_ENABLED || !sb || !S.user) return;
  if (!S.rawFileBytes || !S.fileName) { setStatus('Open a PDF first.'); return; }
  const name = projectNameInput.value.trim() || S.fileName;
  setStatus('Saving…');
  try {
    const { data: project, error: projErr } = await sb
      .from('projects').insert({ user_id: S.user.id, name }).select().single();
    if (projErr) throw projErr;

    const path = S.user.id + '/' + project.id + '/' + S.fileName;
    const blob = new Blob([S.rawFileBytes], { type: 'application/pdf' });
    const { error: upErr } = await sb.storage.from(BUCKET).upload(path, blob, { upsert: true });
    if (upErr) throw upErr;

    const { error: fileErr } = await sb.from('project_files')
      .insert({ project_id: project.id, storage_path: path, filename: S.fileName });
    if (fileErr) throw fileErr;

    logUsageEvent('project_saved', { project_id: project.id });
    setStatus('Saved.');
    projectNameInput.value = '';
    await refreshProjectsList();
  } catch (err) {
    console.warn('Save to cloud failed:', err);
    setStatus('Save failed: ' + (err.message || err));
  }
}

async function refreshProjectsList() {
  projectsList.innerHTML = '<div class="empty-note">Loading…</div>';
  const { data: projects, error } = await sb
    .from('projects').select('id,name,created_at,project_files(id,storage_path,filename)')
    .order('created_at', { ascending: false });
  if (error) { projectsList.innerHTML = '<div class="empty-note">Could not load projects.</div>'; return; }
  if (!projects.length) { projectsList.innerHTML = '<div class="empty-note">No saved projects yet.</div>'; return; }

  projectsList.innerHTML = '';
  for (const p of projects) {
    const row = document.createElement('div');
    row.className = 'project-row';
    const file = p.project_files && p.project_files[0];

    const meta = document.createElement('div');
    meta.className = 'project-meta';
    meta.innerHTML = '<div class="project-name"></div><div class="project-sub"></div>';
    meta.querySelector('.project-name').textContent = p.name;
    meta.querySelector('.project-sub').textContent = new Date(p.created_at).toLocaleString() +
      (file ? '' : ' — no file attached');
    row.appendChild(meta);

    const btnRow = document.createElement('div');
    btnRow.className = 'project-btns';
    if (file) {
      const openBtn = document.createElement('button');
      openBtn.textContent = 'Open';
      openBtn.addEventListener('click', () => openProjectFile(file));
      btnRow.appendChild(openBtn);
    }
    const delBtn = document.createElement('button');
    delBtn.className = 'cancel';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => deleteProject(p, file));
    btnRow.appendChild(delBtn);
    row.appendChild(btnRow);

    projectsList.appendChild(row);
  }
}

async function openProjectFile(file) {
  setStatus('Downloading…');
  const { data, error } = await sb.storage.from(BUCKET).download(file.storage_path);
  if (error) { setStatus('Download failed: ' + error.message); return; }
  const pdfFile = new File([data], file.filename, { type: 'application/pdf' });
  projectsOverlay.hidden = true;
  await loadPdf(pdfFile);
  setStatus('');
}

async function deleteProject(project, file) {
  if (!window.confirm('Delete "' + project.name + '"? This cannot be undone.')) return;
  if (file) await sb.storage.from(BUCKET).remove([file.storage_path]);
  const { error } = await sb.from('projects').delete().eq('id', project.id);
  if (error) { setStatus('Delete failed: ' + error.message); return; }
  await refreshProjectsList();
}

function initProjects() {
  if (!CLOUD_ENABLED) return;
  projectsBtn.addEventListener('click', () => {
    projectsOverlay.hidden = false;
    setStatus('');
    refreshProjectsList();
  });
  projectsCloseBtn.addEventListener('click', () => { projectsOverlay.hidden = true; });
  saveProjectBtn.addEventListener('click', saveCurrentAsProject);
}

export { initProjects };
