(function () {
  'use strict';

  const KEY = 'performance-settings';
  const PROFILES = {
    potato: { preview: [854, 480, 15], export: [1280, 720, 24] },
    balanced: { preview: [1280, 720, 24], export: [1920, 1080, 30] },
    high: { preview: [1920, 1080, 30], export: [1920, 1080, 30] }
  };
  const QUALITY = {
    '480p15': [854, 480, 15],
    '720p24': [1280, 720, 24],
    '1080p30': [1920, 1080, 30],
    '1080p60': [1920, 1080, 60]
  };
  const TTS_ENGINES = [
    { value: 'auto', label: 'Auto (browser speech)' },
    { value: 'phonon', label: 'Phonon 31M · English' },
    { value: 'kokoro', label: 'Kokoro-82M · multilingual' },
    { value: 'browser', label: 'Browser Speech Synthesis' }
  ];
  const defaults = {
    profile: 'auto',
    previewQuality: 'auto',
    exportQuality: 'auto',
    ttsEngine: 'auto',
    loadedTtsEngine: null,
    ttsLanguage: 'en',
    ttsVoice: '',
    browserVoice: '',
    autoAdapt: true,
    benchmark: null,
    recommendedProfile: 'balanced',
    recommendationReason: 'No profile measurements yet; Balanced is the conservative default.'
  };
  const state = {
    settings: { ...defaults },
    capabilities: {
      memoryHint: null,
      cores: null,
      webgpu: 'unknown',
      adapter: 'unknown',
      mimeTypes: [],
      storage: null,
      canvas: null,
      profiler: 'Checking…'
    },
    engines: {
      phonon: { instance: null, module: null, loading: null },
      kokoro: { instance: null, module: null, loading: null }
    },
    task: null,
    slowFrames: [],
    ttsProgressAt: 0,
    previewNoticeShown: false,
    previewDowngraded: false,
    adapterChecked: false,
    phononWorkerUrl: null
  };
  let settingsReady;
  let dbPromise;

  function openDb() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB is unavailable.'));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('AnnotationVideoStudio', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('work')) db.createObjectStore('work', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open settings storage.'));
      request.onblocked = () => reject(new Error('Settings storage is blocked by another tab.'));
    });
    return dbPromise;
  }

  async function loadSettings() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('work', 'readonly');
      const request = tx.objectStore('work').get(KEY);
      request.onsuccess = () => resolve(request.result && request.result.value);
      request.onerror = () => reject(request.error || new Error('Could not read settings.'));
    });
  }

  async function saveSettings() {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('work', 'readwrite');
        tx.objectStore('work').put({ key: KEY, value: { ...state.settings } });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('Could not save performance settings.'));
        tx.onabort = () => reject(tx.error || new Error('Performance settings save was cancelled.'));
      });
      status('performance-status', 'Performance settings saved separately from images, scenes, and rendered output.', 'ok');
      return true;
    } catch (error) {
      status('performance-status', 'Settings could not be saved: ' + error.message + ' Project data was not changed.', 'error');
      return false;
    }
  }

  function status(id, message, kind) {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = message;
    element.className = 'performance-status' + (kind ? ' ' + kind : '');
  }

  function setTaskControls(busy) {
    ['render-video', 'add-scene', 'clear-local-data', 'tts-engine', 'tts-voice', 'tts-language', 'delete-tts-cache']
      .forEach(id => {
        const element = document.getElementById(id);
        if (element) element.disabled = busy;
      });
    const generate = document.getElementById('generate-scene-audio');
    if (generate) {
      const transcript = document.getElementById('scene-tts');
      generate.disabled = busy || !transcript || !transcript.value.trim();
    }
  }

  function setTtsProgress(message, loaded, total) {
    state.ttsProgressAt = Date.now();
    const wrap = document.getElementById('tts-progress-wrap');
    const progress = document.getElementById('tts-progress');
    const label = document.getElementById('tts-progress-label');
    if (!wrap || !progress || !label) return;
    wrap.hidden = false;
    wrap.setAttribute('aria-busy', 'true');
    label.textContent = message;
    if (Number.isFinite(loaded) && Number.isFinite(total) && total > 0) {
      progress.max = 100;
      progress.value = Math.max(0, Math.min(100, loaded / total * 100));
      label.textContent += ' ' + Math.round(progress.value) + '% (' + formatBytes(loaded) + ' / ' + formatBytes(total) + ')';
    } else {
      progress.removeAttribute('value');
    }
    status('tts-status', message);
  }

  function clearTtsProgress() {
    const wrap = document.getElementById('tts-progress-wrap');
    const progress = document.getElementById('tts-progress');
    if (wrap) {
      wrap.hidden = true;
      wrap.removeAttribute('aria-busy');
    }
    if (progress) progress.removeAttribute('value');
  }

  function withLoadTimeout(promise, engine) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(engine + ' is still initializing after 3 minutes. Check your connection, storage permission, and browser console; retry or switch to browser speech.')), 180000);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function formatBytes(value) {
    if (!Number.isFinite(value)) return 'Unknown';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let amount = value, unit = 0;
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
    return amount.toFixed(unit > 0 ? 1 : 0) + ' ' + units[unit];
  }

  function bounded(promise, milliseconds, fallback) {
    let timer;
    return Promise.race([
      Promise.resolve(promise),
      new Promise(resolve => { timer = setTimeout(() => resolve(fallback), milliseconds); })
    ]).finally(() => clearTimeout(timer));
  }

  function recommend(caps) {
    const mem = caps.memoryHint, cores = caps.cores, canvas = caps.canvas;
    if ((mem !== null && mem <= 2) || (cores !== null && cores <= 2) ||
        (canvas && canvas.meanMs > 24)) {
      return {
        profile: 'potato',
        reason: 'A reported low-memory/core hint or slow measured canvas probe favors Potato; browser hints are not guarantees.'
      };
    }
    if (mem !== null && mem >= 8 && cores !== null && cores >= 8 &&
        caps.adapter === 'available' && canvas && canvas.meanMs < 8) {
      return {
        profile: 'high',
        reason: 'High reported RAM/core hints, a working WebGPU adapter, and a fast canvas probe support High Quality.'
      };
    }
    return {
      profile: 'balanced',
      reason: 'Balanced is the conservative choice when capability signals are typical, mixed, or unknown.'
    };
  }

  async function probe(includeCanvas) {
    const nav = navigator;
    const caps = state.capabilities;
    try { caps.memoryHint = Number.isFinite(nav.deviceMemory) ? nav.deviceMemory : null; } catch (_) { caps.memoryHint = null; }
    try { caps.cores = Number.isFinite(nav.hardwareConcurrency) ? nav.hardwareConcurrency : null; } catch (_) { caps.cores = null; }
    let gpu = null;
    try { gpu = nav.gpu || null; } catch (_) {}
    caps.webgpu = gpu ? 'available' : 'unavailable';
    caps.adapter = gpu ? 'unknown' : 'unavailable';
    if (!state.adapterChecked && gpu && typeof gpu.requestAdapter === 'function') {
      try {
        const adapter = await bounded(gpu.requestAdapter(), 1500, null);
        caps.adapter = adapter ? 'available' : 'unavailable';
      } catch (_) {
        caps.adapter = 'unavailable';
      }
      state.adapterChecked = true;
    } else if (state.adapterChecked && caps.adapter === 'unknown') {
      caps.adapter = 'unavailable';
    }
    caps.mimeTypes = [];
    if (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
      caps.mimeTypes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
        .filter(type => { try { return MediaRecorder.isTypeSupported(type); } catch (_) { return false; } });
    }
    caps.recorder = typeof MediaRecorder !== 'undefined' ? 'available' : 'unavailable';
    caps.capture = typeof HTMLCanvasElement !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.captureStream === 'function' ? 'available' : 'unavailable';
    try {
      const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
      caps.speech = synth && typeof synth.speak === 'function' &&
        typeof SpeechSynthesisUtterance !== 'undefined' ? 'available' : 'unavailable';
    }
    catch (_) { caps.speech = 'unavailable'; }
    caps.storage = null;
    try {
      if (nav.storage && typeof nav.storage.estimate === 'function') {
        const estimate = await bounded(nav.storage.estimate(), 1500, null);
        caps.storage = estimate ? {
          usage: Number.isFinite(estimate.usage) ? estimate.usage : null,
          quota: Number.isFinite(estimate.quota) ? estimate.quota : null
        } : { usage: null, quota: null };
      }
    } catch (_) { caps.storage = { usage: null, quota: null }; }
    if (includeCanvas) caps.canvas = await canvasBenchmark();
    const choice = recommend(caps);
    state.settings.recommendedProfile = choice.profile;
    state.settings.recommendationReason = choice.reason;
    caps.profiler = 'Profiled ' + new Date().toLocaleString();
    return choice;
  }

  async function canvasBenchmark() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 270;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return { meanMs: null, frames: 0 };
      const started = performance.now();
      const frames = 48;
      for (let i = 0; i < frames; i++) {
        ctx.fillStyle = i % 2 ? '#26384c' : '#d64b38';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#fff';
        ctx.fillRect((i * 13) % canvas.width, (i * 17) % canvas.height, 48, 27);
      }
      const elapsed = Math.max(0.1, performance.now() - started);
      canvas.width = 1;
      canvas.height = 1;
      return { meanMs: elapsed / frames, frames, elapsedMs: elapsed };
    } catch (_) {
      return { meanMs: null, frames: 0 };
    }
  }

  function activeProfile() {
    return state.settings.profile === 'auto' ? state.settings.recommendedProfile : state.settings.profile;
  }

  function configFor(kind) {
    const quality = kind === 'preview' ? state.settings.previewQuality : state.settings.exportQuality;
    let selected = quality !== 'auto' && QUALITY[quality] ? QUALITY[quality] : PROFILES[activeProfile()][kind];
    if (kind === 'preview' && quality === 'auto' && state.previewDowngraded) {
      selected = activeProfile() === 'high' ? QUALITY['720p24'] : QUALITY['480p15'];
    }
    return { width: selected[0], height: selected[1], fps: selected[2], profile: activeProfile(), quality };
  }

  function memoryEstimate(kind) {
    const config = configFor(kind), base = config.width * config.height * 4 * (kind === 'export' ? 3 : 2);
    return formatBytes(base * 0.75) + '–' + formatBytes(base * 1.5) + ' approximate working set';
  }

  function renderDetails() {
    const details = document.getElementById('performance-details');
    if (!details) return;
    const c = state.capabilities;
    const p = configFor('preview'), e = configFor('export');
    const storage = c.storage
      ? formatBytes(c.storage.usage) + ' used / ' + formatBytes(c.storage.quota) + ' quota (browser estimate)'
      : 'Unavailable';
    const modelSize = state.settings.ttsEngine === 'kokoro'
      ? 'About 92.4 MB for the documented q8 ONNX weights; extra files vary'
      : state.settings.ttsEngine === 'phonon'
        ? 'Unknown; no authoritative package download size stated'
        : 'Not applicable';
    const pairs = [
      ['Profile recommendation', (state.settings.recommendedProfile || 'balanced') + ' — ' + state.settings.recommendationReason],
      ['Browser-reported RAM hint', c.memoryHint === null ? 'Unknown / unavailable' : c.memoryHint + ' GB (approximate hint, not free RAM)'],
      ['Browser-reported logical cores', c.cores === null ? 'Unknown / unavailable' : String(c.cores)],
      ['Browser Speech Synthesis', c.speech || 'Unknown'],
      ['WebGPU API / adapter', c.webgpu + ' / ' + c.adapter],
      ['MediaRecorder / canvas capture', c.recorder + ' / ' + c.capture],
      ['Supported recording MIME types', c.mimeTypes.length ? c.mimeTypes.join(', ') : 'None detected'],
      ['Measured canvas probe', c.canvas && Number.isFinite(c.canvas.meanMs) ? c.canvas.meanMs.toFixed(2) + ' ms / 480×270 draw (' + c.frames + ' draws)' : 'Not measured'],
      ['Storage usage / quota', storage],
      ['Preview configuration', p.width + '×' + p.height + ' at ' + p.fps + ' FPS; ' + memoryEstimate('preview')],
      ['Export configuration', e.width + '×' + e.height + ' at ' + e.fps + ' FPS; ' + memoryEstimate('export')],
      ['Selected TTS / model download', state.settings.ttsEngine + ' / ' + modelSize],
      ['Estimated neural runtime memory', state.settings.ttsEngine === 'browser' || state.settings.ttsEngine === 'auto' ? 'Not applicable' : 'Unknown; not published as a reliable runtime range'],
      ['Profiler status', c.profiler]
    ];
    details.replaceChildren();
    pairs.forEach(([term, value]) => {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = term;
      dd.textContent = value;
      details.append(dt, dd);
    });
  }

  function refreshUi() {
    const profile = document.getElementById('performance-profile');
    if (!profile) return;
    profile.value = state.settings.profile;
    document.getElementById('preview-quality').value = state.settings.previewQuality;
    document.getElementById('export-quality').value = state.settings.exportQuality;
    if (engineSearch) updateEngineInput();
    else document.getElementById('tts-engine').value = (TTS_ENGINES.find(item => item.value === state.settings.ttsEngine) || TTS_ENGINES[0]).label;
    document.getElementById('auto-adapt').checked = state.settings.autoAdapt;
    document.getElementById('tts-language').value = state.settings.ttsLanguage;
    if (voiceSearch) updateVoices();
    const effective = activeProfile();
    const preview = configFor('preview'), exportCfg = configFor('export');
    document.getElementById('performance-summary').textContent =
      'Using ' + effective + ' · preview ' + preview.width + '×' + preview.height + '/' + preview.fps +
      ' · export ' + exportCfg.width + '×' + exportCfg.height + '/' + exportCfg.fps +
      ' · ' + (state.settings.ttsEngine === 'auto' ? 'browser speech' : state.settings.ttsEngine);
    document.getElementById('performance-recommendation').textContent =
      'Recommended: ' + (state.settings.recommendedProfile || 'balanced');
    const quality60 = document.querySelector('#export-quality option[value="1080p60"]');
    if (quality60) {
      quality60.disabled = !(state.capabilities.canvas && Number.isFinite(state.capabilities.canvas.meanMs) &&
        state.capabilities.canvas.meanMs < 8 && state.capabilities.recorder === 'available' &&
        state.capabilities.capture === 'available');
      quality60.title = quality60.disabled ? 'Requires a fast measured canvas and available recording APIs.' : '';
      if (state.settings.exportQuality === '1080p60' && quality60.disabled) {
        status('performance-status', 'The saved 60 FPS export remains selected, but current browser measurements do not support it.', 'error');
      }
    }
    renderDetails();
    document.dispatchEvent(new CustomEvent('performancechange', {
      detail: { profile: effective, preview: configFor('preview'), export: configFor('export') }
    }));
  }

  function normalizeChoice(value) {
    return String(value || '').normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function editDistance(left, right) {
    const row = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i++) {
      let diagonal = row[0];
      row[0] = i;
      for (let j = 1; j <= right.length; j++) {
        const previous = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
        diagonal = previous;
      }
    }
    return row[right.length];
  }

  function closestChoice(query, options) {
    const normalized = normalizeChoice(query);
    if (!normalized) return null;
    const choices = options.map(option => ({ ...option, normalized: normalizeChoice(option.label + ' ' + option.value) }));
    const exact = choices.find(option => normalizeChoice(option.label) === normalized || normalizeChoice(option.value) === normalized);
    if (exact) return exact;
    const starts = choices.find(option => option.normalized.startsWith(normalized));
    if (starts) return starts;
    const contains = choices.find(option => option.normalized.includes(normalized));
    if (contains) return contains;
    const queryWords = normalized.split(' ');
    let best = null, bestScore = Infinity;
    choices.forEach(option => {
      const optionWords = option.normalized.split(' ');
      const score = Math.min(...queryWords.map(word =>
        Math.min(...optionWords.map(candidate => editDistance(word, candidate)))));
      if (score < bestScore) { best = option; bestScore = score; }
    });
    return best && bestScore <= Math.max(2, Math.floor(normalized.length * 0.6)) ? best : null;
  }

  function attachSearchInput(inputId, datalistId, hintId, getOptions, onChoice) {
    const input = document.getElementById(inputId);
    const datalist = document.getElementById(datalistId);
    const hint = document.getElementById(hintId);
    if (!input || !datalist || !hint) return;
    function renderOptions() {
      datalist.replaceChildren();
      getOptions().forEach(option => {
        const item = document.createElement('option');
        item.value = option.label;
        datalist.append(item);
      });
    }
    function find(query) { return closestChoice(query, getOptions()); }
    function updateHint() {
      const choice = find(input.value);
      hint.textContent = input.value.trim()
        ? choice ? 'Closest match: ' + choice.label + ' — press Enter to apply.' : 'No close match. Choose a listed option or try another search.'
        : '';
    }
    function apply() {
      const choice = find(input.value);
      if (!choice) { updateHint(); return false; }
      input.value = choice.label;
      hint.textContent = 'Selected: ' + choice.label;
      onChoice(choice);
      return true;
    }
    input.addEventListener('input', updateHint);
    input.addEventListener('change', apply);
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        apply();
      }
    });
    return {
      renderOptions,
      setValue(value) {
        const choice = getOptions().find(option => option.value === value);
        input.value = choice ? choice.label : '';
        hint.textContent = '';
        renderOptions();
      },
      apply,
      setDisabled(disabled) { input.disabled = disabled; }
    };
  }

  let engineSearch, voiceSearch;
  function updateEngineInput() {
    if (engineSearch) engineSearch.setValue(state.settings.ttsEngine);
    const removeButton = document.getElementById('delete-tts-cache');
    if (removeButton) removeButton.hidden = !['phonon', 'kokoro'].includes(state.settings.ttsEngine);
  }

  function voiceOptions() {
    const engine = state.settings.ttsEngine;
    const language = state.settings.ttsLanguage;
    const options = [];
    if (engine === 'browser' || engine === 'auto') {
      let voices = [];
      try { voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : []; } catch (_) {}
      const languagePrefix = language.toLowerCase();
      const matchingVoices = voices.filter(voice => String(voice.lang || '').toLowerCase().startsWith(languagePrefix));
      if (matchingVoices.length) voices = matchingVoices;
      else if (language === 'hi') voices = [];
      options.push(...voices.map(voice => ({ value: voice.name, label: voice.name + ' (' + voice.lang + ')' })));
    } else if (engine === 'kokoro' && state.engines.kokoro.instance) {
      const voiceMap = state.engines.kokoro.instance.voices || {};
      Object.entries(voiceMap).forEach(([key, voice]) => {
        const voiceLang = String(voice && typeof voice === 'object' ? voice.language || '' : '').toLowerCase();
        const isHindi = ['hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi'].includes(key) ||
          voiceLang.includes('hindi') || voiceLang === 'hi' || voiceLang.startsWith('hi-');
        const hasLanguage = Boolean(voiceLang);
        const isEnglish = !isHindi && (!hasLanguage || voiceLang === 'en' || voiceLang.startsWith('en-') ||
          voiceLang.includes('english'));
        if (language === 'hi' ? isHindi : isEnglish) {
          options.push({ value: key, label: key + ' — ' + (voiceLang || (isHindi ? 'Hindi' : 'English default')) });
        }
      });
    } else if (engine === 'kokoro') {
      if (language === 'hi') {
        ['hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi'].forEach(key =>
          options.push({ value: key, label: key + ' — Hindi' }));
      } else {
        options.push({ value: 'af_heart', label: 'af_heart — English default' });
      }
    } else if (engine === 'phonon' && state.engines.phonon.instance) {
      options.push({ value: '', label: 'Model default' });
      (state.engines.phonon.instance.voices || []).forEach(voice => options.push({ value: voice, label: voice }));
    }
    if (!options.length) options.push({ value: '', label: engine === 'phonon' ? 'Model default (English)' :
      engine === 'browser' || engine === 'auto' ? 'System default (no ' + (language === 'hi' ? 'Hindi' : 'English') + ' voice detected)' : 'Default voice' });
    const wanted = engine === 'browser' || engine === 'auto' ? state.settings.browserVoice : state.settings.ttsVoice;
    if (!options.some(item => item.value === wanted)) {
      if (engine === 'browser' || engine === 'auto') state.settings.browserVoice = options[0].value;
      else state.settings.ttsVoice = options[0].value;
      saveSettings();
    }
    return options;
  }

  function updateVoices() {
    if (!voiceSearch) return;
    const engine = state.settings.ttsEngine;
    const wanted = engine === 'browser' || engine === 'auto' ? state.settings.browserVoice : state.settings.ttsVoice;
    voiceSearch.setValue(wanted);
  }

  function initializeTtsSearch() {
    engineSearch = attachSearchInput('tts-engine', 'tts-engine-options', 'tts-engine-match',
      () => TTS_ENGINES, option => {
        setField('ttsEngine', option.value);
        updateVoices();
        document.getElementById('tts-fallback').hidden = true;
        status('tts-status', option.value === 'auto' || option.value === 'browser'
          ? 'Speech engine selected. Browser speech is ready without a model download.'
          : option.label + ' selected. Press Test / load to initialize; cached files are reused where available.');
      });
    voiceSearch = attachSearchInput('tts-voice', 'tts-voice-options', 'tts-voice-match',
      voiceOptions, option => {
        if (state.settings.ttsEngine === 'browser' || state.settings.ttsEngine === 'auto') {
          state.settings.browserVoice = option.value;
        } else {
          state.settings.ttsVoice = option.value;
        }
        saveSettings();
      });
    updateEngineInput();
    updateVoices();
    if (['phonon', 'kokoro'].includes(state.settings.ttsEngine) &&
        state.settings.loadedTtsEngine === state.settings.ttsEngine) {
      status('tts-status', state.settings.ttsEngine + ' is your saved default. Its browser-cached model will be reused when initialized; searching/selecting a voice does not reload the model.');
    }
  }

  async function deleteSelectedModelCache() {
    const engine = state.settings.ttsEngine;
    if (!['phonon', 'kokoro'].includes(engine)) throw new Error('Choose a neural model before deleting its cached files.');
    if (!('caches' in window)) throw new Error('This browser does not support Cache Storage; its model cache cannot be managed here.');
    const slot = state.engines[engine];
    if (slot.loading) throw new Error('The model is still loading. Wait for the load to finish or time out before deleting its cache.');
    if (slot.instance) {
      try { if (typeof slot.instance.dispose === 'function') await slot.instance.dispose(); } catch (_) {}
      try { if (typeof slot.instance.close === 'function') await slot.instance.close(); } catch (_) {}
      slot.instance = null;
    }
    let removed = 0;
    if (engine === 'phonon') {
      removed = Number(await caches.delete('phonon-tts-v1'));
    } else {
      const marker = 'onnx-community/Kokoro-82M-v1.0-ONNX'.toLowerCase();
      const names = await caches.keys();
      for (const name of names) {
        const cache = await caches.open(name);
        const requests = await cache.keys();
        for (const request of requests) {
          let url = request.url.toLowerCase();
          try { url = decodeURIComponent(url); } catch (_) {}
          if (url.includes(marker)) {
            if (await cache.delete(request)) removed++;
          }
        }
      }
    }
    state.settings.loadedTtsEngine = null;
    await saveSettings();
    status('tts-status', removed
      ? 'Deleted the cached ' + (engine === 'phonon' ? 'Phonon model cache' : 'Kokoro model files (' + removed + ' cached file(s))') + '. The model will download again only if you load it.'
      : 'No cached files for this model were found. Nothing was deleted; the selected engine and voice are unchanged.',
      removed ? 'ok' : '');
    updateVoices();
  }

  function blobFromPcm(samples, sampleRate) {
    const pcm = samples instanceof Float32Array ? samples : new Float32Array(samples);
    const bytes = new ArrayBuffer(44 + pcm.length * 2);
    const view = new DataView(bytes);
    const write = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
    write(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true); write(8, 'WAVE');
    write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    write(36, 'data'); view.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) {
      const sample = Math.max(-1, Math.min(1, pcm[i]));
      view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
    }
    return new Blob([bytes], { type: 'audio/wav' });
  }

  function getSpeechSynthesis() {
    try { return typeof window !== 'undefined' ? window.speechSynthesis || null : null; }
    catch (_) { return null; }
  }

  async function browserSpeech(text) {
    let synth;
    try { synth = getSpeechSynthesis(); } catch (_) {}
    if (!synth || typeof synth.speak !== 'function' || typeof SpeechSynthesisUtterance === 'undefined') {
      throw new Error('Browser Speech Synthesis is unavailable.');
    }
    try { if (typeof synth.cancel === 'function') synth.cancel(); } catch (_) {}
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = state.settings.ttsLanguage === 'hi' ? 'hi-IN' : 'en-US';
    const selected = state.settings.browserVoice;
    let voices = [];
    try { voices = typeof synth.getVoices === 'function' ? synth.getVoices() : []; } catch (_) {}
    if (!Array.isArray(voices)) voices = [];
    const voice = voices.find(item => item.name === selected);
    if (voice) utterance.voice = voice;
    const started = performance.now();
    await new Promise((resolve, reject) => {
      utterance.onend = resolve;
      utterance.onerror = event => reject(new Error('Speech synthesis failed: ' + (event.error || 'unknown error')));
      synth.speak(utterance);
    });
    const seconds = (performance.now() - started) / 1000;
    status('tts-status', 'Browser speech played in ' + seconds.toFixed(2) +
      ' s (playback time; generation time is not exposed). Browser speech cannot provide a downloadable WAV.', 'ok');
  }

  async function synthesizeWav(text) {
    const engine = state.settings.ttsEngine;
    if (engine === 'phonon') {
      if (state.settings.ttsLanguage !== 'en') {
        throw new Error('Phonon 31M is English-only. Choose English or select Kokoro / browser speech for Hindi.');
      }
      const instance = await loadPhonon();
      setTtsProgress('Generating speech with Phonon…');
      let blob;
      try { blob = await instance.synthWav(text, { voice: state.settings.ttsVoice || undefined }); }
      finally { clearTtsProgress(); }
      if (!(blob instanceof Blob)) throw new Error('Phonon returned an unsupported audio object.');
      return { blob, engine };
    }
    if (engine === 'kokoro') {
      const instance = await loadKokoro();
      const fallbackVoice = state.settings.ttsLanguage === 'hi' ? 'hf_alpha' : 'af_heart';
      const voice = state.settings.ttsVoice || fallbackVoice;
      setTtsProgress('Generating speech with Kokoro…');
      let output;
      try { output = await instance.generate(text, { voice }); }
      finally { clearTtsProgress(); }
      const pcm = output && output.audio;
      const sampleRate = output && (output.sampling_rate || output.samplingRate);
      if (!(pcm instanceof Float32Array) || !Number.isFinite(sampleRate)) {
        throw new Error('Kokoro returned an unsupported audio object.');
      }
      return { blob: blobFromPcm(pcm, sampleRate), engine };
    }
    throw new Error('Choose a supported TTS engine before generating transcript audio.');
  }

  async function disposeEngineSlot(engine) {
    const slot = state.engines[engine];
    if (!slot || !slot.instance) return;
    try { if (typeof slot.instance.dispose === 'function') await slot.instance.dispose(); } catch (_) {}
    try { if (typeof slot.instance.close === 'function') await slot.instance.close(); } catch (_) {}
    try {
      if (slot.instance.model && typeof slot.instance.model.dispose === 'function') await slot.instance.model.dispose();
    } catch (_) {}
    slot.instance = null;
  }

  async function disposeOtherEngines(selectedEngine) {
    for (const engine of Object.keys(state.engines)) {
      if (engine !== selectedEngine) await disposeEngineSlot(engine);
    }
  }

  async function loadPhonon() {
    const slot = state.engines.phonon;
    await disposeOtherEngines('phonon');
    if (slot.instance) return slot.instance;
    if (slot.loading) return withLoadTimeout(slot.loading, 'Phonon');
    const loading = (async () => {
      setTtsProgress('Connecting to load Phonon code and English voice model…');
      if (!slot.module) slot.module = await import('https://cdn.jsdelivr.net/npm/phonon-tts@0.7.1/index.js');
      setTtsProgress('Initializing Phonon WASM and checking its cached English q8 model…');
      const workerScript = "import('https://cdn.jsdelivr.net/npm/phonon-tts@0.7.1/worker.js');";
      state.phononWorkerUrl = URL.createObjectURL(new Blob([workerScript], { type: 'text/javascript' }));
      try {
        return await slot.module.PhononTTS.load({
          lang: 'en',
          quant: 'q8',
          cache: true,
          device: 'auto',
          threads: 'auto',
          workerUrl: state.phononWorkerUrl,
          onProgress: progress => {
            state.ttsProgressAt = Date.now();
            const file = progress.file || 'model data';
            setTtsProgress('Phonon · ' + file + (progress.cached ? ' · from browser cache' : ' · downloading'), progress.loaded, progress.total);
          }
        });
      } finally {
        URL.revokeObjectURL(state.phononWorkerUrl);
        state.phononWorkerUrl = null;
      }
    })();
    return completeEngineLoad('phonon', loading);
  }

  async function loadKokoro() {
    const slot = state.engines.kokoro;
    await disposeOtherEngines('kokoro');
    if (slot.instance) return slot.instance;
    if (slot.loading) return withLoadTimeout(slot.loading, 'Kokoro');
    const loading = (async () => {
      setTtsProgress('Connecting to load Kokoro code and multilingual model…');
      if (!slot.module) slot.module = await import('https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js');
      const device = state.capabilities.adapter === 'available' ? 'webgpu' : 'wasm';
      setTtsProgress('Initializing Kokoro q8 model on ' + device + ' (about 92.4 MB of weights plus supporting files)…');
      return slot.module.KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
        dtype: 'q8',
        device,
        progress_callback: progress => {
          state.ttsProgressAt = Date.now();
          const name = progress.file || progress.name || 'model data';
          const loaded = Number(progress.loaded) || 0, total = Number(progress.total) || 0;
          setTtsProgress('Kokoro · ' + name + (progress.status === 'done' ? ' · ready' : ' · loading'), loaded, total);
        }
      });
    })();
    return completeEngineLoad('kokoro', loading);
  }

  async function completeEngineLoad(engine, loading) {
    const slot = state.engines[engine];
    slot.loading = loading;
    let lastWaitingNotice = 0;
    const progressWatch = setInterval(() => {
      if (Date.now() - state.ttsProgressAt < 15000 || Date.now() - lastWaitingNotice < 15000) return;
      lastWaitingNotice = Date.now();
      const label = document.getElementById('tts-progress-label');
      if (label) label.textContent = 'Still waiting for ' + (engine === 'phonon' ? 'Phonon' : 'Kokoro') +
        ' to respond. The progress bar remains active; check network access and browser storage permission.';
    }, 5000);
    loading.then(instance => {
      if (slot.loading === loading) slot.loading = null;
      slot.instance = instance;
      state.settings.ttsEngine = engine;
      state.settings.loadedTtsEngine = engine;
      if (engine === 'kokoro' && !state.settings.ttsVoice) {
        state.settings.ttsVoice = state.settings.ttsLanguage === 'hi' ? 'hf_alpha' : 'af_heart';
      }
      updateEngineInput();
      updateVoices();
      clearTtsProgress();
      status('tts-status', engine + ' is ready and selected as the saved default. Its model files are cached by this browser where supported.', 'ok');
      saveSettings();
    }, () => {
      if (slot.loading === loading) slot.loading = null;
    });
    try {
      return await withLoadTimeout(loading, engine === 'phonon' ? 'Phonon' : 'Kokoro');
    } catch (error) {
      if (error && /3 minutes/.test(error.message || '')) {
        setTtsProgress('No completion after 3 minutes. The load may still finish in the background; check network/storage permissions before retrying.');
      }
      throw error;
    } finally {
      clearInterval(progressWatch);
    }
  }

  async function playBlob(blob) {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    try {
      await new Promise((resolve, reject) => {
        audio.onended = resolve;
        audio.onerror = () => reject(new Error('Generated audio could not be played.'));
        const result = audio.play();
        if (result && typeof result.catch === 'function') result.catch(reject);
      });
    } finally {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
    }
  }

  async function testSelectedEngine() {
    await settingsReady;
    if (state.task) throw new Error('A ' + state.task + ' task is already running.');
    state.task = 'TTS';
    document.getElementById('test-tts').disabled = true;
    document.getElementById('run-benchmarks').disabled = true;
    document.getElementById('tts-fallback').hidden = true;
    try {
      const engine = state.settings.ttsEngine;
      setTaskControls(true);
      document.getElementById('tts-engine').disabled = true;
      document.getElementById('tts-voice').disabled = true;
      document.getElementById('tts-language').disabled = true;
      const start = performance.now();
      if (engine === 'auto' || engine === 'browser') {
        await browserSpeech('This is a short test from Annotation and Video Studio.');
        return;
      }
      setTtsProgress('Starting ' + (engine === 'phonon' ? 'Phonon' : 'Kokoro') +
        ' initialization. A moving bar indicates setup; byte progress appears when the model reports it.');
      const { blob } = await synthesizeWav('This is a short test from Annotation and Video Studio.');
      const duration = await audioDuration(blob);
      status('tts-status', 'Playing the generated test sample…');
      await playBlob(blob);
      const elapsed = (performance.now() - start) / 1000;
      status('tts-status', engine + ' generated ' + duration.toFixed(2) + ' s of test audio in ' + elapsed.toFixed(2) +
        ' s (real-time ratio ' + (elapsed / Math.max(duration, 0.01)).toFixed(2) + '×).', 'ok');
    } catch (error) {
      clearTtsProgress();
      status('tts-status', 'TTS test/load failed: ' + (error && error.message || error) +
        ' Your selection and project data are unchanged. Use the explicit fallback action if desired.', 'error');
      document.getElementById('tts-fallback').hidden = false;
    } finally {
      state.task = null;
      document.getElementById('test-tts').disabled = false;
      document.getElementById('run-benchmarks').disabled = false;
      document.getElementById('tts-engine').disabled = false;
      document.getElementById('tts-voice').disabled = false;
      document.getElementById('tts-language').disabled = false;
      setTaskControls(false);
      updateVoices();
      refreshUi();
    }
  }

  async function generateTranscript(text) {
    await settingsReady;
    if (state.task) throw new Error('A ' + state.task + ' task is already running.');
    const transcript = String(text || '').trim();
    if (!transcript) throw new Error('Enter a scene transcript before generating audio.');
    state.task = 'TTS';
    setTaskControls(true);
    document.getElementById('test-tts').disabled = true;
    document.getElementById('run-benchmarks').disabled = true;
    document.getElementById('tts-fallback').hidden = true;
    try {
      const engine = state.settings.ttsEngine;
      if (engine === 'auto' || engine === 'browser') {
        await browserSpeech(transcript);
        return { browserSpeech: true, blob: null };
      }
      const { blob } = await synthesizeWav(transcript);
      status('tts-status', 'Generated WAV audio for the selected scene transcript. It is separate from the rendered WebM.', 'ok');
      return { browserSpeech: false, blob };
    } catch (error) {
      clearTtsProgress();
      status('tts-status', 'Transcript audio generation failed: ' + (error && error.message || error) +
        ' Your engine selection and project data are unchanged. Use the explicit browser fallback if desired.', 'error');
      document.getElementById('tts-fallback').hidden = false;
      throw error;
    } finally {
      state.task = null;
      document.getElementById('test-tts').disabled = false;
      document.getElementById('run-benchmarks').disabled = false;
      setTaskControls(false);
      updateVoices();
      refreshUi();
    }
  }

  function audioDuration(blob) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(blob), audio = document.createElement('audio');
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => {
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url); resolve(duration);
      };
      audio.onerror = () => { audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url); resolve(0); };
      audio.src = url;
    });
  }

  function setField(name, value) {
    state.settings[name] = value;
    if (name === 'profile' || name === 'previewQuality') {
      state.previewDowngraded = false;
      state.previewNoticeShown = false;
    }
    refreshUi();
    return saveSettings();
  }

  function recordFrame(durationMs, fps) {
    state.slowFrames.push({ durationMs, expectedMs: 1000 / fps });
    if (state.slowFrames.length > 30) state.slowFrames.shift();
    if (state.slowFrames.length < 8 || !state.settings.autoAdapt || state.previewNoticeShown) return;
    const slowRatio = state.slowFrames.filter(frame => frame.durationMs > frame.expectedMs * 1.5).length / state.slowFrames.length;
    if (slowRatio > 0.35) {
      state.previewNoticeShown = true;
      if (state.settings.previewQuality === 'auto' && activeProfile() !== 'potato') {
        state.previewDowngraded = true;
        const config = configFor('preview');
        status('performance-status', 'Slow preview detected; auto adaptation reduced preview to ' + config.width + '×' + config.height +
          ' / ' + config.fps + ' FPS. Export settings are unchanged.', 'error');
        refreshUi();
        document.dispatchEvent(new CustomEvent('performanceslow', { detail: { slowRatio, preview: config } }));
      } else {
        status('performance-status', 'Preview capture is running slowly. The selected preview override and final export settings are unchanged; lower preview quality manually if needed.', 'error');
        document.dispatchEvent(new CustomEvent('performanceslow', { detail: { slowRatio, preview: configFor('preview') } }));
      }
    }
  }

  const manager = {
    ready: null,
    getSettings: () => ({ ...state.settings }),
    getCapabilities: () => JSON.parse(JSON.stringify(state.capabilities)),
    getPreviewConfig: () => configFor('preview'),
    getExportConfig: () => configFor('export'),
    getRecommendation: () => ({ profile: state.settings.recommendedProfile, reason: state.settings.recommendationReason }),
    getTask: () => state.task,
    saveSettings,
    setField,
    recordFrame,
    updateVoices,
    testSelectedEngine,
    generateTranscript,
    async runBenchmarks() {
      if (state.task) throw new Error('A ' + state.task + ' task is already running.');
      state.task = 'benchmark';
      setTaskControls(true);
      document.getElementById('run-benchmarks').disabled = true;
      document.getElementById('test-tts').disabled = true;
      document.getElementById('tts-engine').disabled = true;
      status('performance-status', 'Running the small 480×270 canvas probe and refreshing available browser hints…');
      try {
        await probe(true);
        state.settings.benchmark = state.capabilities.canvas;
        await saveSettings();
        refreshUi();
        status('performance-status', state.settings.recommendationReason, 'ok');
      } finally {
        state.task = null;
        document.getElementById('run-benchmarks').disabled = false;
        document.getElementById('test-tts').disabled = false;
        document.getElementById('tts-engine').disabled = false;
        setTaskControls(false);
      }
    },
    async beginTask(name) {
      await settingsReady;
      if (state.task) throw new Error('A ' + state.task + ' task is already running.');
      state.task = name;
      setTaskControls(true);
      document.getElementById('test-tts').disabled = true;
      document.getElementById('run-benchmarks').disabled = true;
      document.getElementById('tts-engine').disabled = true;
    },
    endTask() {
      state.task = null;
      const test = document.getElementById('test-tts'), benchmark = document.getElementById('run-benchmarks');
      if (test) test.disabled = false;
      if (benchmark) benchmark.disabled = false;
      document.getElementById('tts-engine').disabled = false;
      setTaskControls(false);
    },
    async selectBrowserFallback() {
      await manager.disposeEngines();
      state.settings.ttsEngine = 'browser';
      await saveSettings();
      refreshUi();
      document.getElementById('tts-fallback').hidden = true;
      const synth = getSpeechSynthesis();
      if (!synth || typeof synth.speak !== 'function') {
        status('tts-status', 'Browser Speech Synthesis is unavailable in this browser.', 'error');
        return;
      }
      status('tts-status', 'Browser Speech Synthesis selected. Choose a voice and test it; neural models are not loaded.', 'ok');
      await manager.testSelectedEngine();
    },
    async disposeEngines() {
      await Promise.all(Object.keys(state.engines).map(disposeEngineSlot));
    }
  };
  window.PerformanceManager = manager;

  async function initialize() {
    try {
      const saved = await loadSettings();
      if (saved && typeof saved === 'object') state.settings = { ...defaults, ...saved };
    } catch (error) {
      status('performance-status', 'Settings could not be loaded: ' + error.message + ' The editor will continue without changing project data.', 'error');
    }
    const needsInitialBenchmark = !state.settings.benchmark;
    if (!needsInitialBenchmark) state.capabilities.canvas = state.settings.benchmark;
    await probe(needsInitialBenchmark);
    if (needsInitialBenchmark && state.capabilities.canvas) state.settings.benchmark = state.capabilities.canvas;
    await saveSettings();
    initializeTtsSearch();
    refreshUi();
    updateVoices();
    try {
    const synth = getSpeechSynthesis();
    if (synth) {
      if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', updateVoices);
      setTimeout(updateVoices, 250);
    }
    } catch (_) {}
    document.getElementById('performance-profile').addEventListener('change', event => setField('profile', event.target.value));
    document.getElementById('preview-quality').addEventListener('change', event => setField('previewQuality', event.target.value));
    document.getElementById('export-quality').addEventListener('change', event => setField('exportQuality', event.target.value));
    document.getElementById('tts-language').addEventListener('change', event => {
      setField('ttsLanguage', event.target.value);
      updateVoices();
    });
    document.getElementById('auto-adapt').addEventListener('change', event => setField('autoAdapt', event.target.checked));
    document.getElementById('run-benchmarks').addEventListener('click', () => manager.runBenchmarks().catch(error =>
      status('performance-status', error.message, 'error')));
    document.getElementById('test-tts').addEventListener('click', () => manager.testSelectedEngine());
    document.getElementById('tts-fallback').addEventListener('click', () => manager.selectBrowserFallback());
    document.getElementById('delete-tts-cache').addEventListener('click', async () => {
      if (state.task) {
        status('tts-status', 'Wait for the current ' + state.task + ' task to finish before deleting a model.', 'error');
        return;
      }
      const engine = state.settings.ttsEngine;
      const model = engine === 'phonon' ? 'Phonon' : 'Kokoro';
      if (!window.confirm('Delete the cached ' + model + ' model files from this browser? This frees storage; loading it again will download the model again.')) return;
      state.task = 'cache cleanup';
      setTaskControls(true);
      document.getElementById('test-tts').disabled = true;
      document.getElementById('run-benchmarks').disabled = true;
      try { await deleteSelectedModelCache(); }
      catch (error) { status('tts-status', 'Could not delete the cached model: ' + (error.message || error), 'error'); }
      finally {
        state.task = null;
        setTaskControls(false);
        document.getElementById('test-tts').disabled = false;
        document.getElementById('run-benchmarks').disabled = false;
      }
    });
    window.addEventListener('beforeunload', () => {
      try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (_) {}
      manager.disposeEngines();
    });
  }

  manager.ready = settingsReady = initialize();
})();
