/* PeopleFinder front - vanilla JS + Leaflet */

(function () {
  "use strict";

  // ===== Constantes couleurs =====
  // Palette ordinale chaude : orange clair -> rouge sombre
  const COLORS = {
    low: "#fb923c",     // orange clair - confiance faible
    medium: "#ef4444",  // rouge vif - confiance moyenne
    high: "#991b1b",    // rouge sombre - confiance forte
  };
  const TODO_COLOR = "#06b6d4"; // cyan pour les traces "a explorer"
  const CONFIDENCE_LABEL = {
    low: "Faible",
    medium: "Moyen",
    high: "Fort",
  };
  // Halo en pixels (approximation visuelle, pas un buffer geodesique)
  const HALO_WIDTH_PX = { low: 14, medium: 22, high: 32 };
  const HALO_OPACITY = 0.4;
  const HALO_OPACITY_HIGHLIGHT = 0.65;
  const HALO_OPACITY_DIMMED = 0.08;
  const LINE_WIDTH_PX = 6;
  const LINE_OUTLINE_PX = 9;
  const LINE_OUTLINE_COLOR = "#1a1a1a";
  const DELETED_OPACITY = 0.4;
  const DIMMED_LINE_OPACITY = 0.18;
  const DIMMED_LINE_COLOR = "#9ca3af";
  const TODO_DASH = "12, 10";
  const LIST_LIMIT = 5;

  // Detection desktop (hover possible) pour activer le spotlight hover
  const HAS_HOVER =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  // ===== Etat global =====
  const state = {
    traces: [],            // [{ ...trace, _layers: {...} }]
    showDeleted: false,
    manualMode: false,
    manualKind: null,      // 'search' | 'todo' quand actif
    manualPoints: [],      // [[lat, lng], ...]
    manualLayers: { polyline: null, markers: [] },
    pendingGpxFile: null,
    pendingGpxKind: null,  // 'search' | 'todo'
    metaKind: null,        // 'search' | 'todo' au moment de la modale meta
    metaSource: null,      // 'manual' | 'gpx'
    deletionTarget: null,
    selectedId: null,      // id de la trace s\u00e9lectionn\u00e9e sur la carte (persistant)
    hoveredId: null,       // id de la trace survol\u00e9e dans le panneau
  };

  // ===== Map et calques de fond =====
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
      attribution:
        "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics",
    }
  );

  const map = L.map("map", {
    zoomControl: true,
    doubleClickZoom: false,
    layers: [osmLayer],
  }).setView([46.6, 2.5], 6);

  L.control
    .layers(
      { OSM: osmLayer, Topographique: topoLayer, Satellite: satLayer },
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

  function toLeafletLatLngs(points) {
    return points.map((p) => [p[1], p[0]]);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function traceColor(t) {
    if (t.kind === "todo") return TODO_COLOR;
    return COLORS[t.confidence] || "#888";
  }

  function findTraceById(id) {
    return state.traces.find((t) => t.id === id) || null;
  }

  // ===== Rendu des traces sur la carte =====
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
      const isTodo = t.kind === "todo";
      const color = traceColor(t);
      const latlngs = toLeafletLatLngs(t.points);
      const layers = {};

      if (!isDeleted && !isTodo) {
        layers.halo = L.polyline(latlngs, {
          color: color,
          weight: HALO_WIDTH_PX[t.confidence] || 18,
          opacity: HALO_OPACITY,
          lineCap: "round",
          lineJoin: "round",
          interactive: false,
        }).addTo(map);
      }

      if (!isDeleted) {
        layers.outline = L.polyline(latlngs, {
          color: LINE_OUTLINE_COLOR,
          weight: LINE_OUTLINE_PX,
          opacity: 0.9,
          lineCap: "round",
          lineJoin: "round",
          interactive: false,
        }).addTo(map);
      }

      let dashArray = null;
      if (isDeleted) dashArray = "6, 8";
      else if (isTodo) dashArray = TODO_DASH;

      // Les supprim\u00e9es ne sont pas interactives (pas de selection possible)
      layers.line = L.polyline(latlngs, {
        color: color,
        weight: LINE_WIDTH_PX,
        opacity: isDeleted ? DELETED_OPACITY : 1.0,
        dashArray: dashArray,
        lineCap: "round",
        lineJoin: "round",
        interactive: !isDeleted,
      }).addTo(map);

      if (!isDeleted) {
        layers.line.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          selectTrace(t.id);
        });
      }

      const typeLabel = isTodo ? " (\u00e0 explorer)" : "";
      layers.line.bindTooltip(
        `<strong>${escapeHtml(t.name)}${typeLabel}</strong><br>` +
          `${escapeHtml(t.author)} \u00b7 ${formatDateFR(t.recorded_at)}`,
        { sticky: true }
      );

      t._layers = layers;
    }
  }

  function fitToAlive() {
    const alive = state.traces.filter((t) => !t.deleted_at);
    if (alive.length === 0) return;
    let minLat = Infinity, minLon = Infinity;
    let maxLat = -Infinity, maxLon = -Infinity;
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

  // ===== Spotlight (hover ou selection) =====
  function applyNormalStyle(t) {
    if (!t._layers) return;
    const isDeleted = !!t.deleted_at;
    const color = traceColor(t);
    if (t._layers.halo) {
      t._layers.halo.setStyle({ opacity: HALO_OPACITY, color: color });
    }
    if (t._layers.outline) {
      t._layers.outline.setStyle({ opacity: 0.9, color: LINE_OUTLINE_COLOR });
    }
    if (t._layers.line) {
      t._layers.line.setStyle({
        opacity: isDeleted ? DELETED_OPACITY : 1.0,
        color: color,
      });
    }
  }

  function applyDimmedStyle(t) {
    if (!t._layers) return;
    if (t._layers.halo) {
      t._layers.halo.setStyle({ opacity: HALO_OPACITY_DIMMED });
    }
    if (t._layers.outline) {
      t._layers.outline.setStyle({ opacity: 0.2 });
    }
    if (t._layers.line) {
      t._layers.line.setStyle({
        opacity: DIMMED_LINE_OPACITY,
        color: DIMMED_LINE_COLOR,
      });
    }
  }

  // Recalcule l'affichage selon l'etat (selection persistante > hover)
  function refreshSpotlight() {
    const focusId = state.selectedId || state.hoveredId;
    if (!focusId) {
      for (const t of state.traces) applyNormalStyle(t);
      return;
    }
    for (const t of state.traces) {
      if (!t._layers) continue;
      if (t.id === focusId) {
        applyNormalStyle(t);
        if (t._layers.halo) {
          t._layers.halo.setStyle({ opacity: HALO_OPACITY_HIGHLIGHT });
          t._layers.halo.bringToFront();
        }
        if (t._layers.outline) t._layers.outline.bringToFront();
        if (t._layers.line) t._layers.line.bringToFront();
      } else {
        applyDimmedStyle(t);
      }
    }
  }

  function highlightTraceHover(id) {
    if (!HAS_HOVER) return;
    state.hoveredId = id;
    refreshSpotlight();
    syncListSelection();
  }
  function unhighlightHover() {
    if (!HAS_HOVER) return;
    state.hoveredId = null;
    refreshSpotlight();
    syncListSelection();
  }

  // ===== Selection persistante via clic carte =====
  function selectTrace(id) {
    state.selectedId = id;
    const t = findTraceById(id);
    if (!t) return;
    refreshSpotlight();
    syncListSelection();
    openTracePopup(t);
  }

  function deselectTrace() {
    state.selectedId = null;
    map.closePopup();
    refreshSpotlight();
    syncListSelection();
  }

  function openTracePopup(t) {
    if (!t._layers || !t._layers.line) return;
    // Position : centre de la bbox de la trace (ou centre des points)
    const latlngs = t._layers.line.getLatLngs();
    let popupLatLng = latlngs[Math.floor(latlngs.length / 2)];
    if (!popupLatLng) popupLatLng = latlngs[0];

    const isTodo = t.kind === "todo";
    const lines = [];
    lines.push(`<div class="popup-title">${escapeHtml(t.name)}</div>`);
    const subParts = [escapeHtml(t.author), formatDateFR(t.recorded_at)];
    if (!isTodo && t.confidence) {
      subParts.push(CONFIDENCE_LABEL[t.confidence] || t.confidence);
    }
    if (isTodo) subParts.push("\u00e0 explorer");
    lines.push(`<div class="popup-sub">${subParts.join(" \u00b7 ")}</div>`);
    lines.push(
      '<div class="popup-actions">' +
        '<button type="button" class="btn btn-danger popup-delete">Supprimer</button>' +
        '<button type="button" class="btn popup-close">Fermer</button>' +
        '</div>'
    );

    const container = document.createElement("div");
    container.className = "popup-content";
    container.innerHTML = lines.join("");
    container.querySelector(".popup-delete").addEventListener("click", () => {
      openDeleteModal(t);
    });
    container.querySelector(".popup-close").addEventListener("click", () => {
      deselectTrace();
    });

    L.popup({ closeButton: false, autoClose: false, closeOnClick: false })
      .setLatLng(popupLatLng)
      .setContent(container)
      .openOn(map);
  }

  // ===== Liste laterale (2 sections, 5 derniers chacun) =====
  function renderLists() {
    const alive = state.traces.filter((t) => !t.deleted_at);
    const searchAlive = alive.filter((t) => t.kind !== "todo").slice(0, LIST_LIMIT);
    const todoAlive = alive.filter((t) => t.kind === "todo").slice(0, LIST_LIMIT);

    renderListInto($("#search-list"), $(".search-empty"), searchAlive);
    renderListInto($("#todo-list"), $(".todo-empty"), todoAlive);
    syncListSelection();
  }

  function renderListInto(ul, emptyEl, traces) {
    ul.innerHTML = "";
    if (traces.length === 0) {
      emptyEl.classList.remove("hidden");
      return;
    }
    emptyEl.classList.add("hidden");
    for (const t of traces) {
      const isTodo = t.kind === "todo";
      const li = document.createElement("li");
      li.className = "trace-item" + (isTodo ? " trace-todo" : "");
      li.dataset.traceId = t.id;

      const swatch = document.createElement("span");
      swatch.className = "trace-color";
      swatch.style.background = traceColor(t);
      if (isTodo) swatch.classList.add("swatch-todo");

      const meta = document.createElement("div");
      meta.className = "trace-meta";

      const name = document.createElement("div");
      name.className = "trace-name";
      name.textContent = t.name;

      const sub = document.createElement("div");
      sub.className = "trace-sub";
      const parts = [t.author, formatDateFR(t.recorded_at)];
      if (!isTodo && t.confidence) {
        parts.push(CONFIDENCE_LABEL[t.confidence] || t.confidence);
      }
      sub.textContent = parts.join(" \u00b7 ");

      meta.appendChild(name);
      meta.appendChild(sub);

      li.appendChild(swatch);
      li.appendChild(meta);

      // Clic = selectionne la trace (m\u00eame logique que clic carte)
      li.style.cursor = "pointer";
      li.addEventListener("click", () => {
        // Zoom + selection
        if (t.bbox) {
          map.fitBounds(
            [[t.bbox.min_lat, t.bbox.min_lon], [t.bbox.max_lat, t.bbox.max_lon]],
            { padding: [40, 40] }
          );
        }
        selectTrace(t.id);
      });

      if (HAS_HOVER) {
        li.addEventListener("mouseenter", () => highlightTraceHover(t.id));
        li.addEventListener("mouseleave", () => unhighlightHover());
      }

      ul.appendChild(li);
    }
  }

  function syncListSelection() {
    const focusId = state.selectedId || state.hoveredId;
    $$(".trace-item").forEach((li) => {
      const id = li.dataset.traceId;
      li.classList.toggle("selected", id === focusId);
    });
  }

  // ===== Fetch =====
  async function loadTraces() {
    const params = new URLSearchParams();
    if (state.showDeleted) params.set("include_deleted", "true");
    const url = "/traces" + (params.toString() ? "?" + params.toString() : "");
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
    // Si la trace selectionnee disparait du resultat, deselectionner
    if (state.selectedId && !data.some((t) => t.id === state.selectedId)) {
      state.selectedId = null;
      map.closePopup();
    }
    clearTraceLayers();
    state.traces = data;
    renderTraceLayers();
    renderLists();
    refreshSpotlight();
  }

  async function postManualTrace(kind, payload) {
    const url = kind === "todo" ? "/traces/todo" : "/traces";
    const resp = await fetch(url, {
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

  async function postGpxTrace(kind, file, meta) {
    const url = kind === "todo" ? "/traces/todo/gpx" : "/traces/gpx";
    const fd = new FormData();
    fd.append("file", file);
    fd.append("metadata", JSON.stringify(meta));
    const resp = await fetch(url, { method: "POST", body: fd });
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

  // ===== Boutons d'ajout (action directe) =====
  $$(".btn-upload-gpx").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = btn.getAttribute("data-kind");
      const input = document.querySelector(
        `.gpx-file-input[data-kind="${kind}"]`
      );
      if (input) {
        input.value = "";
        input.click();
      }
    });
  });

  $$(".gpx-file-input").forEach((input) => {
    input.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      const kind = input.getAttribute("data-kind");
      if (file) handleGpxFileSelected(file, kind);
    });
  });

  $$(".btn-start-manual").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = btn.getAttribute("data-kind");
      startManualMode(kind);
    });
  });

  function handleGpxFileSelected(file, kind) {
    if (file.size > 1024 * 1024) {
      toast("Fichier GPX trop volumineux (max 1 Mo)", "error");
      return;
    }
    state.pendingGpxFile = file;
    state.pendingGpxKind = kind;
    openMetaModal("gpx", kind);
  }

  // ===== Fermeture des modales =====
  $$("[data-close]").forEach((el) => {
    el.addEventListener("click", () => hideModal(el.getAttribute("data-close")));
  });

  // ===== Mode manuel =====
  function startManualMode(kind) {
    // Quitter une eventuelle selection
    if (state.selectedId) deselectTrace();
    state.manualMode = true;
    state.manualKind = kind;
    state.manualPoints = [];
    const color = kind === "todo" ? TODO_COLOR : "#2c7be5";
    state.manualLayers.polyline = L.polyline([], {
      color: color,
      weight: 3,
      dashArray: "6, 6",
    }).addTo(map);
    state.manualLayers.markers = [];

    const banner = $("#manual-banner");
    const bannerText = $("#manual-banner-text");
    bannerText.textContent =
      kind === "todo"
        ? "Trac\u00e9 \u00e0 explorer : cliquez sur la carte pour ajouter des points."
        : "Mode manuel : cliquez sur la carte pour ajouter des points.";
    banner.classList.remove("hidden");
    $("#manual-finish").disabled = true;
    $("#manual-undo").disabled = true;
    closePanelMobile();
  }

  function exitManualMode() {
    state.manualMode = false;
    state.manualKind = null;
    if (state.manualLayers.polyline) map.removeLayer(state.manualLayers.polyline);
    state.manualLayers.markers.forEach((m) => map.removeLayer(m));
    state.manualLayers.polyline = null;
    state.manualLayers.markers = [];
    state.manualPoints = [];
    $("#manual-banner").classList.add("hidden");
  }

  function addManualPoint(latlng) {
    state.manualPoints.push([latlng.lat, latlng.lng]);
    const color = state.manualKind === "todo" ? TODO_COLOR : "#2c7be5";
    const marker = L.circleMarker(latlng, {
      radius: 6,
      color: color,
      fillColor: color,
      fillOpacity: 1,
    }).addTo(map);
    state.manualLayers.markers.push(marker);
    refreshManualPolyline();
    updateManualButtons();
  }

  function undoLastManualPoint() {
    if (state.manualPoints.length === 0) return;
    state.manualPoints.pop();
    const m = state.manualLayers.markers.pop();
    if (m) map.removeLayer(m);
    refreshManualPolyline();
    updateManualButtons();
  }

  function updateManualButtons() {
    const n = state.manualPoints.length;
    $("#manual-finish").disabled = n < 2;
    $("#manual-undo").disabled = n === 0;
  }

  function refreshManualPolyline() {
    if (state.manualLayers.polyline) {
      state.manualLayers.polyline.setLatLngs(state.manualPoints);
    }
  }

  // Click sur la carte : soit ajout point (mode manuel), soit deselection
  map.on("click", (e) => {
    if (state.manualMode) {
      addManualPoint(e.latlng);
      return;
    }
    if (state.selectedId) {
      deselectTrace();
    }
  });

  $("#manual-undo").addEventListener("click", () => undoLastManualPoint());
  $("#manual-cancel").addEventListener("click", () => exitManualMode());
  $("#manual-finish").addEventListener("click", () => {
    if (state.manualPoints.length < 2) {
      toast("Une trace doit avoir au moins 2 points", "error");
      return;
    }
    openMetaModal("manual", state.manualKind);
  });

  // Echap = desactiver selection / mode manuel
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (state.manualMode) {
      exitManualMode();
    } else if (state.selectedId) {
      deselectTrace();
    }
  });

  // ===== Modale metadonnees =====
  function openMetaModal(source, kind) {
    state.metaSource = source;
    state.metaKind = kind;
    const form = $("#meta-form");
    form.reset();
    form.elements["recorded_at"].value = todayISO();
    if (form.elements["confidence"]) {
      form.elements["confidence"].value = "medium";
    }
    $("#meta-error").classList.add("hidden");
    $("#meta-error").textContent = "";

    const confField = $("#confidence-field");
    if (kind === "todo") {
      confField.classList.add("hidden");
      if (form.elements["confidence"]) form.elements["confidence"].required = false;
    } else {
      confField.classList.remove("hidden");
      if (form.elements["confidence"]) form.elements["confidence"].required = true;
    }

    const title = $("#modal-meta-title");
    if (kind === "todo") {
      title.textContent =
        source === "gpx"
          ? "M\u00e9tadonn\u00e9es (GPX \u00e0 explorer)"
          : "M\u00e9tadonn\u00e9es du trac\u00e9 \u00e0 explorer";
    } else {
      title.textContent =
        source === "gpx" ? "M\u00e9tadonn\u00e9es (GPX)" : "M\u00e9tadonn\u00e9es du trac\u00e9";
    }
    showModal("modal-meta");
  }

  $("#meta-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const kind = state.metaKind;
    const source = state.metaSource;

    const meta = {
      name: form.elements["name"].value.trim(),
      author: form.elements["author"].value.trim(),
      recorded_at: form.elements["recorded_at"].value,
    };
    if (kind !== "todo") {
      meta.confidence = form.elements["confidence"].value;
    }
    if (!meta.name || !meta.author || !meta.recorded_at) {
      showMetaError("Tous les champs sont requis.");
      return;
    }
    if (kind !== "todo" && !meta.confidence) {
      showMetaError("Le niveau de confiance est requis.");
      return;
    }

    try {
      if (source === "gpx") {
        if (!state.pendingGpxFile) throw new Error("Aucun fichier GPX s\u00e9lectionn\u00e9");
        await postGpxTrace(kind, state.pendingGpxFile, meta);
        state.pendingGpxFile = null;
        state.pendingGpxKind = null;
      } else {
        const points = state.manualPoints.map(([lat, lng]) => [lng, lat]);
        await postManualTrace(kind, { ...meta, points });
        exitManualMode();
      }
      hideModal("modal-meta");
      await loadTraces();
      toast(kind === "todo" ? "Trac\u00e9 \u00e0 explorer ajout\u00e9." : "Trace ajout\u00e9e.");
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
    const label = trace.kind === "todo" ? "le trac\u00e9 \u00e0 explorer" : "la trace";
    $("#modal-delete-text").textContent =
      `Supprimer ${label} "${trace.name}" ? Cette action est irr\u00e9versible.`;
    showModal("modal-delete");
  }
  $("#confirm-delete").addEventListener("click", async () => {
    const t = state.deletionTarget;
    if (!t) return;
    try {
      await deleteTrace(t.id);
      hideModal("modal-delete");
      state.deletionTarget = null;
      // Fermer le popup et la selection avant refresh
      state.selectedId = null;
      map.closePopup();
      await loadTraces();
      toast("Trace supprim\u00e9e.");
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
