import "./style.css";
import cytoscape from "cytoscape";
import fcose from "cytoscape-fcose";
import svg from "cytoscape-svg";

cytoscape.use(fcose);
cytoscape.use(svg);

/* =========================================================================
 *  Estado da aplicação
 * ========================================================================= */
const STORAGE_KEY = "diagrama-relacoes:v1";

/** Tipos de relação padrão (baseados no cenário: apoio / antagonismo / influência). */
const TIPOS_PADRAO = [
  { name: "Apoio / Aliança", color: "#2B6CB0" },
  { name: "Antagonismo", color: "#C53030" },
  { name: "Influência / Dependência", color: "#111827" },
];

const state = {
  groups: [], // { id, name, color }
  nodes: [], // { id, name, group, color, shape }
  edges: [], // { id, source, target, label, color, style, bidir }
  types: structuredClone(TIPOS_PADRAO),
};

let cy;
let idSeq = 1;
const uid = (prefix) => `${prefix}_${idSeq++}_${Date.now().toString(36)}`;

/* =========================================================================
 *  Cytoscape
 * ========================================================================= */
function buildStylesheet() {
  return [
    {
      selector: "node[!isGroup]",
      style: {
        label: "data(label)",
        "background-color": "data(color)",
        "border-width": 2,
        "border-color": "#ffffff",
        color: "#ffffff",
        "text-outline-width": 2,
        "text-outline-color": "data(color)",
        "font-size": 14,
        "font-weight": 700,
        "text-valign": "center",
        "text-halign": "center",
        "text-wrap": "wrap",
        "text-max-width": "160px",
        shape: "data(shape)",
        // Dimensões explícitas calculadas a partir do rótulo (data.w/data.h).
        // Evita o sizing "label", que nesta versão do Cytoscape às vezes
        // deixa nós sem serem pintados após um re-render/layout.
        width: "data(w)",
        height: "data(h)",
      },
    },
    {
      selector: "node[?isGroup]",
      style: {
        label: "data(label)",
        "background-color": "data(color)",
        "background-opacity": 0.35,
        "border-width": 2,
        "border-color": "data(color)",
        "border-opacity": 0.9,
        shape: "round-rectangle",
        color: "#0f172a",
        "font-size": 15,
        "font-weight": 800,
        "text-valign": "top",
        "text-halign": "center",
        "text-margin-y": 6,
        padding: "26px",
      },
    },
    {
      selector: "edge",
      style: {
        label: "data(label)",
        width: 3,
        "line-color": "data(color)",
        "target-arrow-color": "data(color)",
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
        "line-style": "data(style)",
        "font-size": 11,
        "font-weight": 600,
        color: "data(color)",
        "text-outline-width": 3,
        "text-outline-color": "#ffffff",
        "text-rotation": "autorotate",
        "text-background-color": "#ffffff",
        "text-background-opacity": 0.75,
        "text-background-padding": "2px",
        "arrow-scale": 1.1,
      },
    },
    {
      selector: "edge[?bidir]",
      style: { "source-arrow-color": "data(color)", "source-arrow-shape": "triangle" },
    },
    {
      // Relação reforçada: aresta bem mais grossa.
      selector: "edge[estado = 'reforcada']",
      style: { width: 8, "arrow-scale": 1.5 },
    },
    {
      // Relação removida: aresta esmaecida (o X vermelho é desenhado por cima).
      selector: "edge[estado = 'removida']",
      style: { opacity: 0.45 },
    },
    {
      // Marcador de X vermelho no meio das relações removidas.
      selector: "node[?isXmark]",
      style: {
        label: "✕",
        shape: "ellipse",
        width: 26,
        height: 26,
        "background-opacity": 0,
        "border-width": 0,
        color: "#dc2626",
        "font-size": 30,
        "font-weight": 900,
        "text-valign": "center",
        "text-halign": "center",
        "text-outline-width": 3,
        "text-outline-color": "#ffffff",
        events: "no",
        "z-index": 999,
      },
    },
    {
      selector: ":selected",
      style: { "border-width": 4, "border-color": "#f59e0b", "line-color": "#f59e0b" },
    },
    {
      selector: "edge:selected",
      style: { width: 5, "line-color": "#f59e0b", "target-arrow-color": "#f59e0b" },
    },
  ];
}

function initCytoscape() {
  cy = cytoscape({
    container: document.getElementById("cy"),
    style: buildStylesheet(),
    wheelSensitivity: 1,
    minZoom: 0.1,
    maxZoom: 3,
    // Observação: NÃO forçar pixelRatio. Em telas com escala fracionária
    // (ex.: Windows 125% -> devicePixelRatio 1.25), fixar pixelRatio:1 fazia
    // os nós "andarem" mais que o cursor ao arrastar. O bug de pintura que
    // motivou aquilo já é resolvido pelo dimensionamento explícito dos nós.
    textureOnViewport: false,
    motionBlur: false,
  });

  cy.on("tap", "node, edge", (evt) => {
    if (evt.target.data("isXmark")) return;
    openInspector(evt.target);
  });
  cy.on("tap", (evt) => {
    if (evt.target === cy) closeInspector();
  });
  // Salva posições após arrastar
  cy.on("dragfree", "node", persist);

  // Durante o arraste de um nó, os marcadores de "X" seguem o meio da aresta
  // via requestAnimationFrame. IMPORTANTE: não usar os eventos "position"/"drag"
  // para isso — chamar .position() dentro deles reentra no processamento de
  // arraste do Cytoscape e faz o nó arrastado "disparar" (efeito cumulativo).
  cy.on("grab", "node", () => pulseXMarkers(0));
  cy.on("free", "node", () => {
    stopXMarkerPulse();
    positionXMarkers();
  });
}

/* =========================================================================
 *  Marcadores de "X" (relações removidas) — nós do próprio grafo,
 *  para que apareçam também nas exportações PNG/SVG.
 * ========================================================================= */
let xMarkerPulse = null;

/** Reposiciona cada marcador de X sobre o ponto médio de sua aresta. */
function positionXMarkers() {
  if (!cy) return;
  cy.nodes("[?isXmark]").forEach((mk) => {
    const edge = cy.getElementById(mk.data("forEdge"));
    if (edge.empty()) return;
    const mid = edge.midpoint();
    if (mid && !Number.isNaN(mid.x)) mk.position(mid);
  });
}

/**
 * Sincroniza os X via requestAnimationFrame.
 * - durationMs > 0: roda por um tempo (usado na animação do layout).
 * - durationMs = 0: roda indefinidamente até stopXMarkerPulse() (usado no arraste).
 */
function pulseXMarkers(durationMs) {
  cancelAnimationFrame(xMarkerPulse);
  const end = durationMs > 0 ? performance.now() + durationMs : Infinity;
  const tick = (now) => {
    positionXMarkers();
    if (now < end) xMarkerPulse = requestAnimationFrame(tick);
  };
  xMarkerPulse = requestAnimationFrame(tick);
}

function stopXMarkerPulse() {
  cancelAnimationFrame(xMarkerPulse);
  xMarkerPulse = null;
}

/**
 * Calcula dimensões explícitas do nó a partir do rótulo.
 * Substitui o sizing "label" do Cytoscape (instável nesta versão) por
 * valores numéricos estáveis, mantendo o ajuste automático ao texto.
 */
function nodeSize(label, shape) {
  const lines = String(label || "").split("\n");
  const maxChars = Math.max(1, ...lines.map((l) => l.length));
  const charW = 8.6; // ~14px Arial bold
  const lineH = 18;
  let w = Math.round(maxChars * charW) + 34;
  let h = lines.length * lineH + 24;
  // Elipses precisam de mais folga para o texto caber dentro da curva.
  if (shape === "ellipse") {
    w = Math.round(w * 1.25);
    h = Math.round(h * 1.35);
  } else if (shape === "diamond") {
    w = Math.round(w * 1.5);
    h = Math.round(h * 1.6);
  }
  return { w: Math.max(w, 56), h: Math.max(h, 40) };
}

function toElements() {
  const els = [];
  for (const g of state.groups) {
    els.push({ data: { id: g.id, label: g.name, isGroup: true, color: g.color } });
  }
  for (const n of state.nodes) {
    const { w, h } = nodeSize(n.name, n.shape || "ellipse");
    const data = { id: n.id, label: n.name, color: n.color, shape: n.shape || "ellipse", w, h };
    if (n.group && state.groups.some((g) => g.id === n.group)) data.parent = n.group;
    const el = { data };
    if (n.x != null && n.y != null) el.position = { x: n.x, y: n.y };
    els.push(el);
  }
  for (const e of state.edges) {
    els.push({
      data: {
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label || "",
        color: e.color,
        style: e.style || "solid",
        bidir: !!e.bidir,
        estado: e.estado || "normal",
      },
    });
  }
  // Marcadores de X para relações removidas (nós auxiliares, não interativos).
  for (const e of state.edges) {
    if (e.estado !== "removida") continue;
    els.push({
      data: { id: "x_" + e.id, isXmark: true, forEdge: e.id },
      selectable: false,
      grabbable: false,
      pannable: true,
    });
  }
  return els;
}

/** Redesenha o grafo a partir do estado, preservando posições já conhecidas. */
function render({ layout = false } = {}) {
  // Guarda posições atuais antes de recriar
  if (cy) {
    cy.nodes().forEach((n) => {
      const s = state.nodes.find((x) => x.id === n.id());
      if (s) {
        const p = n.position();
        s.x = p.x;
        s.y = p.y;
      }
    });
  }
  cy.elements().remove();
  cy.add(toElements());

  const semPosicao = state.nodes.some((n) => n.x == null || n.y == null);
  if (layout || semPosicao) runLayout();
  else {
    positionXMarkers();
    cy.fit(cy.elements("[!isXmark]"), 40);
    positionXMarkers();
  }
}

function runLayout() {
  // Layout roda apenas nos elementos reais; os marcadores de X (nós soltos)
  // ficariam espalhados pelo fcose, então são posicionados manualmente depois.
  cy.elements("[!isXmark]")
    .layout({
      name: "fcose",
      quality: "proof",
      animate: true,
      animationDuration: 500,
      randomize: state.nodes.every((n) => n.x == null),
      nodeSeparation: 120,
      idealEdgeLength: 140,
      nodeRepulsion: 8000,
      padding: 40,
      fit: true,
    })
    .run();
  pulseXMarkers(700);

  cy.one("layoutstop", () => {
    cy.nodes("[!isXmark]").forEach((n) => {
      const s = state.nodes.find((x) => x.id === n.id());
      if (s) {
        const p = n.position();
        s.x = p.x;
        s.y = p.y;
      }
    });
    positionXMarkers();
    cy.forceRender();
    persist();
  });
}

const autoLayoutOn = () => document.getElementById("chk-physics").checked;

/* =========================================================================
 *  Persistência
 * ========================================================================= */
function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize()));
}

function serialize() {
  // Sincroniza posições atuais
  if (cy) {
    cy.nodes("[!isGroup]").forEach((n) => {
      const s = state.nodes.find((x) => x.id === n.id());
      if (s) {
        const p = n.position();
        s.x = p.x;
        s.y = p.y;
      }
    });
  }
  return {
    groups: state.groups,
    nodes: state.nodes,
    edges: state.edges,
    types: state.types,
    idSeq,
  };
}

function loadFromStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    applyData(JSON.parse(raw));
    return true;
  } catch {
    return false;
  }
}

function applyData(data) {
  state.groups = data.groups || [];
  state.nodes = data.nodes || [];
  state.edges = data.edges || [];
  state.types = data.types && data.types.length ? data.types : structuredClone(TIPOS_PADRAO);
  idSeq = data.idSeq || idSeq;
}

/* =========================================================================
 *  Operações de domínio
 * ========================================================================= */
function addGroup(name, color) {
  const g = { id: uid("g"), name, color };
  state.groups.push(g);
  return g;
}

function addNode({ name, group, color, shape }) {
  const n = { id: uid("n"), name, group: group || null, color, shape };
  state.nodes.push(n);
  return n;
}

function addEdge({ source, target, label, color, style, bidir, estado }) {
  const e = { id: uid("e"), source, target, label, color, style, bidir, estado: estado || "normal" };
  state.edges.push(e);
  return e;
}

function removeNode(id) {
  state.nodes = state.nodes.filter((n) => n.id !== id);
  state.edges = state.edges.filter((e) => e.source !== id && e.target !== id);
}

function removeGroup(id) {
  state.groups = state.groups.filter((g) => g.id !== id);
  state.nodes.forEach((n) => {
    if (n.group === id) n.group = null;
  });
}

function removeEdge(id) {
  state.edges = state.edges.filter((e) => e.id !== id);
}

/* =========================================================================
 *  Renderização da UI (listas, selects)
 * ========================================================================= */
const $ = (sel) => document.querySelector(sel);

function refreshUI() {
  refreshGroupSelects();
  refreshNodeSelects();
  refreshTipoSelect();
  refreshListaAtores();
  refreshListaRelacoes();
  refreshListaGrupos();
  refreshListaTipos();
}

function refreshGroupSelects() {
  const sel = $("#ator-grupo");
  sel.innerHTML = `<option value="">— sem grupo —</option>`;
  for (const g of state.groups) {
    const o = document.createElement("option");
    o.value = g.id;
    o.textContent = g.name;
    sel.appendChild(o);
  }
}

function refreshNodeSelects() {
  for (const id of ["#rel-origem", "#rel-destino"]) {
    const sel = $(id);
    const prev = sel.value;
    sel.innerHTML = "";
    for (const n of state.nodes) {
      const o = document.createElement("option");
      o.value = n.id;
      o.textContent = n.name;
      sel.appendChild(o);
    }
    if (state.nodes.some((n) => n.id === prev)) sel.value = prev;
  }
}

function refreshTipoSelect() {
  const sel = $("#rel-tipo");
  sel.innerHTML = "";
  state.types.forEach((t, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = t.name;
    o.dataset.color = t.color;
    sel.appendChild(o);
  });
  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = "Personalizado…";
  sel.appendChild(custom);
}

function refreshListaAtores() {
  const ul = $("#lista-atores");
  $("#count-atores").textContent = state.nodes.length;
  ul.innerHTML = "";
  if (!state.nodes.length) return void (ul.innerHTML = `<div class="empty">Nenhum ator ainda.</div>`);
  for (const n of state.nodes) {
    const g = state.groups.find((x) => x.id === n.group);
    ul.appendChild(
      liItem({
        color: n.color,
        label: n.name,
        sub: g ? g.name : "",
        onFocus: () => focusNode(n.id),
        onDelete: () => {
          removeNode(n.id);
          commit();
        },
      })
    );
  }
}

function refreshListaRelacoes() {
  const ul = $("#lista-relacoes");
  $("#count-relacoes").textContent = state.edges.length;
  ul.innerHTML = "";
  if (!state.edges.length) return void (ul.innerHTML = `<div class="empty">Nenhuma relação ainda.</div>`);
  for (const e of state.edges) {
    const s = state.nodes.find((n) => n.id === e.source);
    const t = state.nodes.find((n) => n.id === e.target);
    const tag = e.estado === "reforcada" ? "⏫ " : e.estado === "removida" ? "✕ " : "";
    ul.appendChild(
      liItem({
        color: e.color,
        label: tag + (e.label || "(sem rótulo)"),
        sub: `${s ? s.name : "?"} ${e.bidir ? "↔" : "→"} ${t ? t.name : "?"}`,
        onFocus: () => focusEdge(e.id),
        onDelete: () => {
          removeEdge(e.id);
          commit();
        },
      })
    );
  }
}

function refreshListaGrupos() {
  const ul = $("#lista-grupos");
  $("#count-grupos").textContent = state.groups.length;
  ul.innerHTML = "";
  if (!state.groups.length) return void (ul.innerHTML = `<div class="empty">Nenhum grupo ainda.</div>`);
  for (const g of state.groups) {
    const membros = state.nodes.filter((n) => n.group === g.id).length;
    ul.appendChild(
      liItem({
        color: g.color,
        label: g.name,
        sub: `${membros} ator(es)`,
        onDelete: () => {
          removeGroup(g.id);
          commit();
        },
      })
    );
  }
}

function refreshListaTipos() {
  const ul = $("#lista-tipos");
  ul.innerHTML = "";
  state.types.forEach((t, i) => {
    ul.appendChild(
      liItem({
        color: t.color,
        label: t.name,
        onDelete: () => {
          state.types.splice(i, 1);
          commit();
        },
      })
    );
  });
}

function liItem({ color, label, sub, onFocus, onDelete }) {
  const li = document.createElement("li");
  const sw = document.createElement("span");
  sw.className = "swatch";
  sw.style.background = color;
  li.appendChild(sw);

  const txt = document.createElement("span");
  txt.className = "item-label";
  txt.innerHTML = `${escapeHtml(label)}${sub ? ` <span class="item-sub">· ${escapeHtml(sub)}</span>` : ""}`;
  if (onFocus) {
    txt.style.cursor = "pointer";
    txt.addEventListener("click", onFocus);
  }
  li.appendChild(txt);

  if (onDelete) {
    const del = document.createElement("button");
    del.className = "icon-btn";
    del.textContent = "×";
    del.title = "Remover";
    del.addEventListener("click", onDelete);
    li.appendChild(del);
  }
  return li;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* =========================================================================
 *  Foco / Inspector
 * ========================================================================= */
function focusNode(id) {
  const el = cy.getElementById(id);
  if (el.nonempty()) {
    cy.animate({ center: { eles: el }, zoom: 1.2 }, { duration: 300 });
    el.select();
    openInspector(el);
  }
}

function focusEdge(id) {
  const el = cy.getElementById(id);
  if (el.nonempty()) {
    cy.animate({ center: { eles: el }, zoom: 1.1 }, { duration: 300 });
    el.select();
    openInspector(el);
  }
}

function openInspector(el) {
  const box = $("#inspector");
  const body = $("#inspector-body");
  box.classList.remove("hidden");
  body.innerHTML = "";

  if (el.isNode() && !el.data("isGroup")) {
    $("#inspector-title").textContent = "Ator";
    const node = state.nodes.find((n) => n.id === el.id());
    if (!node) return;
    body.appendChild(field("Nome", inputText(node.name, (v) => (node.name = v))));
    body.appendChild(field("Cor", inputColor(node.color, (v) => (node.color = v))));
    body.appendChild(
      field(
        "Grupo",
        selectGroup(node.group, (v) => (node.group = v || null))
      )
    );
    body.appendChild(applyBtn());
    body.appendChild(delBtn("Remover ator", () => removeNode(node.id)));
  } else if (el.isNode() && el.data("isGroup")) {
    $("#inspector-title").textContent = "Grupo";
    const grp = state.groups.find((g) => g.id === el.id());
    if (!grp) return;
    body.appendChild(field("Nome", inputText(grp.name, (v) => (grp.name = v))));
    body.appendChild(field("Cor", inputColor(grp.color, (v) => (grp.color = v))));
    body.appendChild(applyBtn());
    body.appendChild(delBtn("Remover grupo", () => removeGroup(grp.id)));
  } else if (el.isEdge()) {
    $("#inspector-title").textContent = "Relação";
    const edge = state.edges.find((e) => e.id === el.id());
    if (!edge) return;
    body.appendChild(field("Rótulo", inputText(edge.label, (v) => (edge.label = v))));
    body.appendChild(field("Cor", inputColor(edge.color, (v) => (edge.color = v))));
    body.appendChild(
      field(
        "Estilo",
        selectFrom(
          [
            ["solid", "Sólida"],
            ["dashed", "Tracejada"],
            ["dotted", "Pontilhada"],
          ],
          edge.style,
          (v) => (edge.style = v)
        )
      )
    );
    body.appendChild(
      field(
        "Situação",
        selectFrom(
          [
            ["normal", "Normal"],
            ["reforcada", "Reforçada"],
            ["removida", "Removida (X)"],
          ],
          edge.estado || "normal",
          (v) => (edge.estado = v)
        )
      )
    );
    body.appendChild(checkField("Bidirecional", edge.bidir, (v) => (edge.bidir = v)));
    body.appendChild(applyBtn());
    body.appendChild(delBtn("Remover relação", () => removeEdge(edge.id)));
  }
}

function closeInspector() {
  $("#inspector").classList.add("hidden");
  cy.$(":selected").unselect();
}

/* Helpers de formulário do inspector */
function field(label, control) {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  wrap.appendChild(control);
  return wrap;
}
function inputText(value, onChange) {
  const i = document.createElement("input");
  i.type = "text";
  i.value = value || "";
  i.addEventListener("input", () => onChange(i.value));
  return i;
}
function inputColor(value, onChange) {
  const i = document.createElement("input");
  i.type = "color";
  i.value = value || "#000000";
  i.addEventListener("input", () => onChange(i.value));
  return i;
}
function selectFrom(pairs, value, onChange) {
  const s = document.createElement("select");
  for (const [v, t] of pairs) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    s.appendChild(o);
  }
  s.value = value;
  s.addEventListener("change", () => onChange(s.value));
  return s;
}
function selectGroup(value, onChange) {
  const s = document.createElement("select");
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "— sem grupo —";
  s.appendChild(none);
  for (const g of state.groups) {
    const o = document.createElement("option");
    o.value = g.id;
    o.textContent = g.name;
    s.appendChild(o);
  }
  s.value = value || "";
  s.addEventListener("change", () => onChange(s.value));
  return s;
}
function checkField(label, value, onChange) {
  const wrap = document.createElement("label");
  wrap.className = "check";
  const c = document.createElement("input");
  c.type = "checkbox";
  c.checked = !!value;
  c.addEventListener("change", () => onChange(c.checked));
  wrap.appendChild(c);
  wrap.appendChild(document.createTextNode(" " + label));
  return wrap;
}
function applyBtn() {
  const b = document.createElement("button");
  b.className = "primary";
  b.textContent = "Aplicar alterações";
  b.addEventListener("click", () => {
    commit({ layout: false });
  });
  return b;
}
function delBtn(text, action) {
  const b = document.createElement("button");
  b.className = "del";
  b.textContent = text;
  b.addEventListener("click", () => {
    action();
    closeInspector();
    commit();
  });
  return b;
}

/* =========================================================================
 *  Commit: aplica mudanças no grafo + UI + storage
 * ========================================================================= */
function commit({ layout = null } = {}) {
  const doLayout = layout != null ? layout : autoLayoutOn();
  render({ layout: doLayout });
  refreshUI();
  persist();
}

/* =========================================================================
 *  Bindings da UI (abas, formulários, toolbar)
 * ========================================================================= */
function bindTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.querySelector(`.tab-panel[data-panel="${btn.dataset.tab}"]`).classList.add("active");
    });
  });
}

function bindForms() {
  // Ator
  $("#form-ator").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#ator-nome").value.trim();
    if (!name) return;
    addNode({
      name,
      group: $("#ator-grupo").value,
      color: $("#ator-cor").value,
      shape: $("#ator-forma").value,
    });
    $("#ator-nome").value = "";
    commit();
  });

  // Grupo
  $("#form-grupo").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#grupo-nome").value.trim();
    if (!name) return;
    addGroup(name, $("#grupo-cor").value);
    $("#grupo-nome").value = "";
    commit();
  });

  // Relação
  $("#form-relacao").addEventListener("submit", (e) => {
    e.preventDefault();
    const source = $("#rel-origem").value;
    const target = $("#rel-destino").value;
    if (!source || !target) {
      alert("Cadastre pelo menos dois atores antes de criar uma relação.");
      return;
    }
    addEdge({
      source,
      target,
      label: $("#rel-label").value.trim(),
      color: $("#rel-cor").value,
      style: $("#rel-estilo").value,
      bidir: $("#rel-bidir").checked,
      estado: $("#rel-estado").value,
    });
    $("#rel-label").value = "";
    commit();
  });

  // Tipo select -> define cor do color picker da relação
  $("#rel-tipo").addEventListener("change", (e) => {
    const opt = e.target.selectedOptions[0];
    if (opt && opt.dataset.color) $("#rel-cor").value = opt.dataset.color;
  });

  // Novo tipo de relação
  $("#form-tipo").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#tipo-nome").value.trim();
    if (!name) return;
    state.types.push({ name, color: $("#tipo-cor").value });
    $("#tipo-nome").value = "";
    commit({ layout: false });
  });

  // Inspector close
  $("#inspector-close").addEventListener("click", closeInspector);
}

function bindToolbar() {
  $("#btn-layout").addEventListener("click", () => {
    state.nodes.forEach((n) => {
      n.x = null;
      n.y = null;
    });
    render({ layout: true });
    persist();
  });

  $("#btn-fit").addEventListener("click", () => cy.fit(undefined, 40));

  $("#btn-png").addEventListener("click", () => {
    const png = cy.png({ full: true, scale: 2, bg: "#ffffff" });
    downloadURI(png, "diagrama-relacoes.png");
  });

  $("#btn-svg").addEventListener("click", () => {
    const svgContent = cy.svg({ full: true, scale: 1, bg: "#ffffff" });
    const blob = new Blob([svgContent], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    downloadURI(url, "diagrama-relacoes.svg");
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $("#btn-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: "application/json" });
    downloadURI(URL.createObjectURL(blob), "diagrama-relacoes.json");
  });

  $("#btn-import").addEventListener("click", () => $("#file-import").click());
  $("#file-import").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        applyData(JSON.parse(reader.result));
        commit({ layout: false });
      } catch {
        alert("Arquivo JSON inválido.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  $("#btn-seed").addEventListener("click", () => {
    if (state.nodes.length && !confirm("Isso substitui o diagrama atual pelo exemplo. Continuar?")) return;
    seedExample();
    commit({ layout: true });
  });

  $("#btn-clear").addEventListener("click", () => {
    if (!confirm("Limpar todo o diagrama?")) return;
    state.groups = [];
    state.nodes = [];
    state.edges = [];
    commit({ layout: false });
  });
}

function downloadURI(uri, name) {
  const a = document.createElement("a");
  a.href = uri;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* =========================================================================
 *  Exemplo (baseado no cenário "Situação Atual")
 * ========================================================================= */
function seedExample() {
  state.groups = [];
  state.nodes = [];
  state.edges = [];
  state.types = structuredClone(TIPOS_PADRAO);

  const AZUL = "#2B6CB0";
  const VERM = "#C53030";
  const PRETO = "#111827";

  const gVer = addGroup("VERMELHO", "#FADBD8");

  const urso = addNode({ name: "URSO", color: "#1F3A5F", shape: "ellipse" });
  const laranja = addNode({ name: "LARANJA", color: "#E67E22", shape: "ellipse" });
  const minoria = addNode({ name: "Minoria\nLimonense", color: "#F1C40F", shape: "ellipse" });
  const maca = addNode({ name: "MAÇÃ", color: "#7B241C", shape: "ellipse" });
  const limao = addNode({ name: "LIMÃO", color: "#9ACD32", shape: "ellipse" });
  const oia = addNode({ name: "OIA", color: "#DAA520", shape: "ellipse" });
  const pop = addNode({ name: "POPULAÇÃO", color: "#E74C3C", shape: "round-rectangle" });
  const cs = addNode({ name: "CS / OPM", color: "#111827", shape: "ellipse" });

  // Grupo vermelho: coloca governo/mídia como membros (exemplo de blob)
  const gov = addNode({ name: "GOVERNO", group: gVer.id, color: "#E06666", shape: "round-rectangle" });
  const midia = addNode({ name: "MÍDIA", group: gVer.id, color: "#E06666", shape: "round-rectangle" });

  const rel = (s, t, label, color, style = "solid", bidir = false) =>
    addEdge({ source: s.id, target: t.id, label, color, style, bidir });

  rel(urso, laranja, "ALIANÇA", AZUL);
  rel(urso, laranja, "DEPENDÊNCIA", PRETO);
  rel(maca, limao, "PARCERIA COMERCIAL", AZUL);
  rel(maca, minoria, "DEPENDÊNCIA", PRETO);
  rel(limao, minoria, "INFLUÊNCIA", PRETO);
  rel(limao, minoria, "APOIO", AZUL);
  rel(laranja, minoria, "REPRESSÃO", VERM);
  rel(laranja, minoria, "RESISTÊNCIA", PRETO);
  rel(laranja, limao, "ANTAGONISMO", VERM, "solid", true);
  rel(laranja, limao, "RESSENTIMENTO", VERM);
  rel(oia, pop, "AMEAÇA", VERM);
  rel(laranja, pop, "AGRESSÃO", VERM);
  rel(cs, laranja, "RESPALDO / APOIO", AZUL);
  rel(pop, laranja, "REINVINDICAÇÃO", VERM);
  rel(cs, limao, "CONDENAÇÃO / RESTRIÇÃO", PRETO);
  rel(limao, oia, "APOIO", AZUL);
  rel(gov, midia, "CONTROLE", PRETO);
}

/* =========================================================================
 *  Bootstrap
 * ========================================================================= */
function main() {
  initCytoscape();
  bindTabs();
  bindForms();
  bindToolbar();

  const had = loadFromStorage();
  if (!had) seedExample();

  render({ layout: !had });
  refreshUI();
}

main();
