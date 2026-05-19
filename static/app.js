/* PeopleFinder front - vanilla JS + Leaflet */

(function () {
  "use strict";

  // ===== Constantes =====
  const COLORS = {
    low: "#e74c3c",
    medium: "#f39c12",
    high: "#f1c40f",
  };
  const CONFIDENCE_LABEL = {
    low: "Faible",
    medium: "Moyen",
    high: "Fort",
  };
  // Halo en pixels (approximation visuelle, pas un buffer geodesique)
  const HALO_WIDTH_PX = { low: 14, medium: 22, high: 32 };
  const HALO_OPACITY = 0.4;
  const LINE_WIDTH_PX = 6;
  const LINE_OUTLINE_PX = 9;
  const LINE_OUTLINE_COLOR = "#1a1a1a";
  const DELETED_OPACITY = 0.4;

  // ===== Etat global =====
  const state = {
    traces: [],            // [{ ...trace, _layers: { line, halo } }]
    showDeleted: false,
    manualMode: false,
    manualPoints: [],      // [[lat, lng], ...]
    manualLayers: {
      polyline: null,
      markers: [],         // L.circleMarker par point
    },
    pendingTrace: null,    // payload partiel en attente de la modale meta
    pendingGpxFile: null,
    deletionTarget: null,
  };

  // ===== Map =====
  const osmLayer = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }
  );
  const topoLayer = L.tileLayer(
    "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 17,
      attribution:
        'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM | Style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    }
  );
  const satLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics",
    }
  );

  const map = L.map("map", {
    zoomControl: true,
    doubleClickZoom: false, // on intercepte le double-clic en mode manuel
    layers: [osmLayer], // OSM par defaut
  }).setView([46.6, 2.5], 6); // France par defaut

  L.control
    .layers(
      {
        OSM: osmLayer,
        Topographique: topoLayer,
        Satellite: satLayer,
      },
      null,
      { position: "topright", collapsed: true }
    )
    .addTo(map);

  // ===== Utilitaires DOM =====
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function showModal(id) { $("#" + id).classList.remove("hidden"); }
  function hideModal(id) { $("#" + id).classList.add("hidden"); }

  let toastTimer = null;
  function toast(msg, kind) {
    const el = $("#toast");
    el.textContent = msg;
    el.style.background = kind === "error" ? "#c0392b" : "#333";
    el.classList.remove("hidden");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
  }

  function formatDateFR(isoString) {
    if (!isoString) return "";
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  function todayISO() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  // GeoJSON points = [lon, lat], Leaflet veut [lat, lon]
  function toLeafletLatLngs(points) {
    return points.map((p) => [p[1], p[0]]);
  }

  // ===== Rendu des traces =====
  function clearTraceLayers() {
    for (const t of state.traces) {
      if (t._layers) {
        if (t._layers.halo) map.removeLayer(t._layers.halo);
        if (t._layers.outline) map.removeLayer(t._layers.outline);
        if (t._layers.line) map.removeLayer(t._layers.line);
      }
      t._layers = null;
    }
  }

  function renderTraceLayers() {
    for (const t of state.traces) {
      const isDeleted = !!t.deleted_at;
      const color = COLORS[t.confidence] || "#888";
      const latlngs = toLeafletLatLngs(t.points);

      const layers = {};

      if (!isDeleted) {
        // Halo (uniquement si vivante) - posé en premier = en dessous
        layers.halo = L.polyline(latlngs, {
          color: color,
          weight: HALO_WIDTH_PX[t.confidence] || 18,
          opacity: HALO_OPACITY,
          lineCap: "round",
          lineJoin: "round",
          interactive: false,
        }).addTo(map);

        // Liseré sombre sous la ligne couleur pour lisibilité sur tout fond
        layers.outline = L.polyline(latlngs, {
          color: LINE_OUTLINE_COLOR,
          weight: LINE_OUTLINE_PX,
          opacity: 0.9,
          lineCap: "round",
          lineJoin: "round",
          interactive: false,
        }).addTo(map);
      }

      layers.line = L.polyline(latlngs, {
        color: color,
        weight: LINE_WIDTH_PX,
        opacity: isDeleted ? DELETED_OPACITY : 1.0,
        dashArray: isDeleted ? "6, 8" : null,
        lineCap: "round",
        lineJoin: "round",
      }).addTo(map);

      layers.line.bindTooltip(
        `<strong>${escapeHtml(t.name)}</strong><br>` +
          `${escapeHtml(t.author)} · ${formatDateFR(t.recorded_at)}`,
        { sticky: true }
      );

      t._layers = layers;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function fitToAlive() {
    const alive = state.traces.filter((t) => !t.deleted_at);
    if (alive.length === 0) return;
    let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
    for (const t of alive) {
      if (!t.bbox) continue;
      if (t.bbox.min_lat < minLat) minLat = t.bbox.min_lat;
      if (t.bbox.min_lon < minLon) minLon = t.bbox.min_lon;
      if (t.bbox.max_lat > maxLat) maxLat = t.bbox.max_lat;
      if (t.bbox.max_lon > maxLon) maxLon = t.bbox.max_lon;
    }
    if (minLat === Infinity) return;
    map.fitBounds([[minLat, minLon], [maxLat, maxLon]], { padding: [40, 40] });
  }

  // ===== Liste laterale =====
  function renderList() {
    const ul = $("#trace-list");
    const empty = $("#trace-empty");
    ul.innerHTML = "";
    if (state.traces.length === 0) {
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    for (const t of state.traces) {
      const li = document.createElement("li");
      li.className = "trace-item" + (t.deleted_at ? " trace-deleted" : "");

      const swatch = document.createElement("span");
      swatch.className = "trace-color";
      swatch.style.background = COLORS[t.confidence] || "#888";

      const meta = document.createElement("div");
      meta.className = "trace-meta";

      const name = document.createElement("div");
      name.className = "trace-name";
      name.textContent = t.name;

      const sub = document.createElement("div");
      sub.className = "trace-sub";
      let subText =
        `${t.author} · ${formatDateFR(t.recorded_at)} · ${CONFIDENCE_LABEL[t.confidence]}`;
      if (t.deleted_at) {
        subText += ` · (supprimée le ${formatDateFR(t.deleted_at)})`;
      }
      sub.textContent = subText;

      meta.appendChild(name);
      meta.appendChild(sub);

      li.appendChild(swatch);
      li.appendChild(meta);

      // Pas de bouton de suppression sur les traces deja supprimees
      if (!t.deleted_at) {
        const actions = document.createElement("div");
        actions.className = "trace-actions";
        const btn = document.createElement("button");
        btn.className = "btn-icon";
        btn.title = "Supprimer";
        btn.setAttribute("aria-label", "Supprimer cette trace");
        btn.textContent = "🗑";
        btn.addEventListener("click", () => openDeleteModal(t));
        actions.appendChild(btn);
        li.appendChild(actions);
      }

      // Cliquer sur l'item zoome sur la trace
      meta.style.cursor = "pointer";
      meta.addEventListener("click", () => {
        if (!t.bbox) return;
        map.fitBounds(
          [[t.bbox.min_lat, t.bbox.min_lon], [t.bbox.max_lat, t.bbox.max_lon]],
          { padding: [40, 40] }
        );
      });

      ul.appendChild(li);
    }
  }

  // ===== Fetch =====
  async function loadTraces() {
    const url = state.showDeleted ? "/traces?include_deleted=true" : "/traces";
    let data;
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      data = await resp.json();
    } catch (err) {
      toast("Erreur de chargement des traces", "error");
      console.error(err);
      return;
    }
    clearTraceLayers();
    state.traces = data;
    renderTraceLayers();
    renderList();
  }

  async function postManualTrace(payload) {
    const resp = await fetch("/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(parseError(txt) || `Erreur ${resp.status}`);
    }
    return await resp.json();
  }

  async function postGpxTrace(file, meta) {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("metadata", JSON.stringify(meta));
    const resp = await fetch("/traces/gpx", { method: "POST", body: fd });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(parseError(txt) || `Erreur ${resp.status}`);
    }
    return await resp.json();
  }

  async function deleteTrace(id) {
    const resp = await fetch(`/traces/${id}`, { method: "DELETE" });
    if (!resp.ok && resp.status !== 204) {
      const txt = await resp.text();
      throw new Error(parseError(txt) || `Erreur ${resp.status}`);
    }
  }

  function parseError(txt) {
    try {
      const j = JSON.parse(txt);
      if (j && j.detail) {
        if (typeof j.detail === "string") return j.detail;
        return JSON.stringify(j.detail);
      }
    } catch (_) {}
    return txt;
  }

  // ===== Modale "ajouter" =====
  $("#btn-add").addEventListener("click", () => {
    // reset
    $("#gpx-file").value = "";
    $("#gpx-filename").textContent = "";
    state.pendingGpxFile = null;
    activateTab("tab-gpx");
    showModal("modal-add");
  });

  $$("[data-close]").forEach((el) => {
    el.addEventListener("click", () => hideModal(el.getAttribute("data-close")));
  });

  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => activateTab(tab.getAttribute("data-tab")));
  });

  function activateTab(id) {
    $$(".tab").forEach((t) => t.classList.toggle("active", t.getAttribute("data-tab") === id));
    $$(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.id !== id));
  }

  // ===== Upload GPX =====
  const dropzone = $("#dropzone");
  ["dragenter", "dragover"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    });
  });
  dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleGpxFileSelected(file);
  });
  $("#gpx-file").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) handleGpxFileSelected(file);
  });

  function handleGpxFileSelected(file) {
    if (file.size > 1024 * 1024) {
      toast("Fichier GPX trop volumineux (max 1 Mo)", "error");
      return;
    }
    state.pendingGpxFile = file;
    $("#gpx-filename").textContent = file.name;
    hideModal("modal-add");
    openMetaModal("gpx");
  }

  // ===== Mode manuel =====
  $("#start-manual").addEventListener("click", () => {
    hideModal("modal-add");
    startManualMode();
  });

  function startManualMode() {
    state.manualMode = true;
    state.manualPoints = [];
    state.manualLayers.polyline = L.polyline([], {
      color: "#2c7be5",
      weight: 3,
      dashArray: "6, 6",
    }).addTo(map);
    state.manualLayers.markers = [];
    $("#manual-banner").classList.remove("hidden");
    $("#manual-finish").disabled = true;
    closePanelMobile();
  }

  function exitManualMode() {
    state.manualMode = false;
    if (state.manualLayers.polyline) map.removeLayer(state.manualLayers.polyline);
    state.manualLayers.markers.forEach((m) => map.removeLayer(m));
    state.manualLayers.polyline = null;
    state.manualLayers.markers = [];
    state.manualPoints = [];
    $("#manual-banner").classList.add("hidden");
  }

  function addManualPoint(latlng) {
    state.manualPoints.push([latlng.lat, latlng.lng]);
    const marker = L.circleMarker(latlng, {
      radius: 6,
      color: "#2c7be5",
      fillColor: "#2c7be5",
      fillOpacity: 1,
    }).addTo(map);
    // Double-clic sur un point existant = annuler le dernier point pose
    marker.on("dblclick", (e) => {
      L.DomEvent.stopPropagation(e);
      undoLastManualPoint();
    });
    state.manualLayers.markers.push(marker);
    refreshManualPolyline();
    $("#manual-finish").disabled = state.manualPoints.length < 2;
  }

  function undoLastManualPoint() {
    if (state.manualPoints.length === 0) return;
    state.manualPoints.pop();
    const m = state.manualLayers.markers.pop();
    if (m) map.removeLayer(m);
    refreshManualPolyline();
    $("#manual-finish").disabled = state.manualPoints.length < 2;
  }

  function refreshManualPolyline() {
    if (state.manualLayers.polyline) {
      state.manualLayers.polyline.setLatLngs(state.manualPoints);
    }
  }

  map.on("click", (e) => {
    if (!state.manualMode) return;
    addManualPoint(e.latlng);
  });

  $("#manual-cancel").addEventListener("click", () => {
    exitManualMode();
  });

  $("#manual-finish").addEventListener("click", () => {
    if (state.manualPoints.length < 2) {
      toast("Une trace doit avoir au moins 2 points", "error");
      return;
    }
    openMetaModal("manual");
  });

  // ===== Modale metadonnees =====
  function openMetaModal(kind) {
    const form = $("#meta-form");
    form.reset();
    form.elements["recorded_at"].value = todayISO();
    form.elements["confidence"].value = "medium";
    $("#meta-error").classList.add("hidden");
    $("#meta-error").textContent = "";
    $("#modal-meta-title").textContent =
      kind === "gpx" ? "Métadonnées (GPX)" : "Métadonnées du tracé";
    form.dataset.kind = kind;
    showModal("modal-meta");
  }

  $("#meta-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const kind = form.dataset.kind;
    const meta = {
      name: form.elements["name"].value.trim(),
      author: form.elements["author"].value.trim(),
      confidence: form.elements["confidence"].value,
      recorded_at: form.elements["recorded_at"].value,
    };
    if (!meta.name || !meta.author || !meta.recorded_at) {
      showMetaError("Tous les champs sont requis.");
      return;
    }

    try {
      if (kind === "gpx") {
        if (!state.pendingGpxFile) throw new Error("Aucun fichier GPX sélectionné");
        await postGpxTrace(state.pendingGpxFile, meta);
        state.pendingGpxFile = null;
      } else {
        // manuel: points [[lat, lng]] -> [[lon, lat]]
        const points = state.manualPoints.map(([lat, lng]) => [lng, lat]);
        await postManualTrace({ ...meta, points });
        exitManualMode();
      }
      hideModal("modal-meta");
      await loadTraces();
      toast("Trace ajoutée.");
    } catch (err) {
      console.error(err);
      showMetaError(err.message || "Erreur lors de l'enregistrement");
    }
  });

  function showMetaError(msg) {
    const el = $("#meta-error");
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  // ===== Modale suppression =====
  function openDeleteModal(trace) {
    state.deletionTarget = trace;
    $("#modal-delete-text").textContent =
      `Supprimer la trace "${trace.name}" ? Cette action est irréversible.`;
    showModal("modal-delete");
  }
  $("#confirm-delete").addEventListener("click", async () => {
    const t = state.deletionTarget;
    if (!t) return;
    try {
      await deleteTrace(t.id);
      hideModal("modal-delete");
      state.deletionTarget = null;
      await loadTraces();
      toast("Trace supprimée.");
    } catch (err) {
      toast(err.message || "Erreur lors de la suppression", "error");
    }
  });

  // ===== Toggle "afficher supprimees" =====
  $("#toggle-show-deleted").addEventListener("change", async (e) => {
    state.showDeleted = e.target.checked;
    await loadTraces();
  });

  // ===== Panneau mobile =====
  function openPanelMobile() { $("#panel").classList.add("open"); }
  function closePanelMobile() { $("#panel").classList.remove("open"); }
  $("#panel-toggle").addEventListener("click", openPanelMobile);
  $("#panel-close").addEventListener("click", closePanelMobile);

  // ===== Boot =====
  (async function init() {
    await loadTraces();
    fitToAlive();
  })();
})();
