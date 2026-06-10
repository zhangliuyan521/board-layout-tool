const STORAGE_KEY = "board-layout-tool-v1";

const state = {
  sheets: [],
  unplaced: [],
  currentSheet: 0,
  mode: "mixed",
  lastCsv: "",
};

const colors = [
  "#156f5b",
  "#2d6290",
  "#d39b35",
  "#8a568d",
  "#c65c48",
  "#4f7f36",
  "#25808d",
  "#9a6a24",
  "#6373b7",
  "#be6f86",
];

const boardsTable = document.querySelector("#boardsTable tbody");
const partsTable = document.querySelector("#partsTable tbody");
const canvas = document.querySelector("#layoutCanvas");
const ctx = canvas.getContext("2d");

function numberValue(value, fallback = 0) {
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integerValue(value, fallback = 0) {
  return Math.max(0, Math.floor(numberValue(value, fallback)));
}

function formatNumber(value) {
  return Math.round(value).toLocaleString("zh-CN");
}

function makeCellInput(value, type = "text", placeholder = "") {
  const input = document.createElement("input");
  input.value = value ?? "";
  input.type = type;
  input.placeholder = placeholder;
  if (type === "number") {
    input.min = "0";
    input.step = "0.1";
    input.inputMode = "decimal";
  }
  input.addEventListener("input", saveDraft);
  return input;
}

function addBoardRow(board = {}) {
  const row = document.createElement("tr");
  const values = [
    makeCellInput(board.name ?? `大板${boardsTable.children.length + 1}`),
    makeCellInput(board.length ?? "", "number"),
    makeCellInput(board.width ?? "", "number"),
    makeCellInput(board.count ?? "", "number", "空=不限"),
  ];

  values.forEach((input) => {
    const cell = document.createElement("td");
    cell.append(input);
    row.append(cell);
  });

  const action = document.createElement("td");
  const button = document.createElement("button");
  button.className = "icon-btn row-remove";
  button.type = "button";
  button.title = "删除";
  button.textContent = "×";
  button.addEventListener("click", () => {
    row.remove();
    saveDraft();
  });
  action.append(button);
  row.append(action);
  boardsTable.append(row);
  saveDraft();
}

function addPartRow(part = {}) {
  const row = document.createElement("tr");
  const values = [
    makeCellInput(part.name ?? `小料${partsTable.children.length + 1}`),
    makeCellInput(part.length ?? "", "number"),
    makeCellInput(part.width ?? "", "number"),
    makeCellInput(part.qty ?? 1, "number"),
  ];

  values.forEach((input) => {
    const cell = document.createElement("td");
    cell.append(input);
    row.append(cell);
  });

  const action = document.createElement("td");
  const button = document.createElement("button");
  button.className = "icon-btn row-remove";
  button.type = "button";
  button.title = "删除";
  button.textContent = "×";
  button.addEventListener("click", () => {
    row.remove();
    saveDraft();
  });
  action.append(button);
  row.append(action);
  partsTable.append(row);
  saveDraft();
}

function readBoards() {
  return [...boardsTable.querySelectorAll("tr")]
    .map((row, index) => {
      const inputs = row.querySelectorAll("input");
      const rawCount = inputs[3].value.trim();
      return {
        id: `board-${index}`,
        name: inputs[0].value.trim() || `大板${index + 1}`,
        w: numberValue(inputs[1].value),
        h: numberValue(inputs[2].value),
        count: rawCount === "" ? Infinity : integerValue(rawCount),
      };
    })
    .filter((board) => board.w > 0 && board.h > 0 && board.count > 0);
}

function readPartGroups() {
  return [...partsTable.querySelectorAll("tr")]
    .map((row, index) => {
      const inputs = row.querySelectorAll("input");
      return {
        id: `part-${index}`,
        name: inputs[0].value.trim() || `小料${index + 1}`,
        w: numberValue(inputs[1].value),
        h: numberValue(inputs[2].value),
        qty: integerValue(inputs[3].value),
        color: colors[index % colors.length],
      };
    })
    .filter((part) => part.w > 0 && part.h > 0 && part.qty > 0);
}

function expandParts(groups, mode, direction) {
  const parts = [];
  groups.forEach((part, groupIndex) => {
    for (let i = 0; i < part.qty; i += 1) {
      const oriented = orientPart(part, mode, direction);
      parts.push({
        ...part,
        ...oriented,
        groupIndex,
        instance: `${part.id}-${i}`,
      });
    }
  });
  return parts.sort((a, b) => b.w * b.h - a.w * a.h || Math.max(b.w, b.h) - Math.max(a.w, a.h));
}

function orientPart(part, mode, direction) {
  if (mode !== "directed") return { w: part.w, h: part.h, forcedRotated: false };
  const shouldBeHorizontal = direction === "horizontal";
  const isHorizontal = part.w >= part.h;
  if (shouldBeHorizontal === isHorizontal) return { w: part.w, h: part.h, forcedRotated: false };
  return { w: part.h, h: part.w, forcedRotated: true };
}

function getOptions() {
  const direction = document.querySelector("input[name='direction']:checked")?.value || "horizontal";
  return {
    mode: state.mode,
    direction,
    kerf: Math.max(0, numberValue(document.querySelector("#kerfInput").value)),
    margin: Math.max(0, numberValue(document.querySelector("#marginInput").value)),
  };
}

// 混拼模式使用 MaxRects：每次选择当前最贴合空位的小料。
class MaxRectsBin {
  constructor(board, kerf, margin) {
    this.board = board;
    this.kerf = kerf;
    this.margin = margin;
    this.innerW = board.w - margin * 2;
    this.innerH = board.h - margin * 2;
    this.free = [{ x: 0, y: 0, w: this.innerW, h: this.innerH }];
    this.used = [];
  }

  orientations(part) {
    const variants = [{ w: part.w, h: part.h, rotated: false }];
    if (part.w !== part.h) variants.push({ w: part.h, h: part.w, rotated: true });
    return variants.map((item) => ({
      ...item,
      rw: item.w + this.kerf,
      rh: item.h + this.kerf,
    }));
  }

  score(part) {
    let best = null;
    for (const item of this.orientations(part)) {
      for (const rect of this.free) {
        if (item.rw > rect.w || item.rh > rect.h) continue;
        const shortSide = Math.min(rect.w - item.rw, rect.h - item.rh);
        const longSide = Math.max(rect.w - item.rw, rect.h - item.rh);
        const score = shortSide * 100000000 + longSide;
        if (!best || score < best.score) best = { rect, item, score };
      }
    }
    return best;
  }

  insert(part) {
    const placement = this.score(part);
    if (!placement) return false;

    const node = {
      ...part,
      x: placement.rect.x,
      y: placement.rect.y,
      w: placement.item.w,
      h: placement.item.h,
      rw: placement.item.rw,
      rh: placement.item.rh,
      rotated: placement.item.rotated,
    };

    const nextFree = [];
    for (const rect of this.free) {
      if (!intersectsReserved(node, rect)) {
        nextFree.push(rect);
        continue;
      }
      splitFreeNode(rect, node).forEach((piece) => {
        if (piece.w > 0.001 && piece.h > 0.001) nextFree.push(piece);
      });
    }

    this.used.push(node);
    this.free = pruneRects(nextFree);
    return true;
  }
}

function intersectsReserved(node, rect) {
  return !(
    node.x >= rect.x + rect.w ||
    node.x + node.rw <= rect.x ||
    node.y >= rect.y + rect.h ||
    node.y + node.rh <= rect.y
  );
}

function splitFreeNode(rect, used) {
  const pieces = [];
  const usedRight = used.x + used.rw;
  const usedBottom = used.y + used.rh;
  const rectRight = rect.x + rect.w;
  const rectBottom = rect.y + rect.h;

  if (used.x > rect.x && used.x < rectRight) pieces.push({ x: rect.x, y: rect.y, w: used.x - rect.x, h: rect.h });
  if (usedRight < rectRight) pieces.push({ x: usedRight, y: rect.y, w: rectRight - usedRight, h: rect.h });
  if (used.y > rect.y && used.y < rectBottom) pieces.push({ x: rect.x, y: rect.y, w: rect.w, h: used.y - rect.y });
  if (usedBottom < rectBottom) pieces.push({ x: rect.x, y: usedBottom, w: rect.w, h: rectBottom - usedBottom });
  return pieces;
}

function pruneRects(rects) {
  return rects.filter((rect, index) => !rects.some((other, otherIndex) => index !== otherIndex && contains(other, rect)));
}

function contains(a, b) {
  return b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
}

function packMixed(board, remaining, options) {
  const bin = new MaxRectsBin(board, options.kerf, options.margin);
  const placedKeys = new Set();
  let progress = true;

  while (progress) {
    progress = false;
    let bestIndex = -1;
    let bestScore = null;

    for (let i = 0; i < remaining.length; i += 1) {
      if (placedKeys.has(remaining[i].instance)) continue;
      const score = bin.score(remaining[i]);
      if (!score) continue;
      if (!bestScore || score.score < bestScore.score) {
        bestIndex = i;
        bestScore = score;
      }
    }

    if (bestIndex >= 0 && bin.insert({ ...remaining[bestIndex] })) {
      placedKeys.add(remaining[bestIndex].instance);
      progress = true;
    }
  }

  return makePackedResult(board, bin.used, placedKeys);
}

// 定向模式不再旋转单个小料，按统一方向逐行/逐列裁切式排布。
function packDirected(board, remaining, options) {
  const placements = [];
  const placedKeys = new Set();
  const innerW = board.w - options.margin * 2;
  const innerH = board.h - options.margin * 2;
  let x = 0;
  let y = 0;
  let laneSize = 0;

  for (const part of remaining) {
    if (placedKeys.has(part.instance)) continue;
    if (part.w > innerW || part.h > innerH) continue;

    if (options.direction === "horizontal") {
      if (x > 0 && x + part.w > innerW) {
        x = 0;
        y += laneSize + options.kerf;
        laneSize = 0;
      }
      if (y + part.h > innerH) continue;
      placements.push({ ...part, x, y, rotated: part.forcedRotated });
      placedKeys.add(part.instance);
      x += part.w + options.kerf;
      laneSize = Math.max(laneSize, part.h);
    } else {
      if (y > 0 && y + part.h > innerH) {
        y = 0;
        x += laneSize + options.kerf;
        laneSize = 0;
      }
      if (x + part.w > innerW) continue;
      placements.push({ ...part, x, y, rotated: part.forcedRotated });
      placedKeys.add(part.instance);
      y += part.h + options.kerf;
      laneSize = Math.max(laneSize, part.w);
    }
  }

  return makePackedResult(board, placements, placedKeys);
}

function makePackedResult(board, placements, placedKeys) {
  return {
    board,
    placements,
    placedKeys,
    partArea: placements.reduce((sum, item) => sum + item.w * item.h, 0),
  };
}

function optimize() {
  const boards = readBoards();
  const groups = readPartGroups();
  const options = getOptions();
  let remaining = expandParts(groups, options.mode, options.direction);

  if (!boards.length) return showMessage("请至少输入一种有效大板规格。", true);
  if (!remaining.length) return showMessage("请至少输入一种有效小料。", true);

  const stockLeft = new Map(boards.map((board) => [board.id, board.count]));
  const sheets = [];
  let guard = 0;

  while (remaining.length && guard < 500) {
    guard += 1;
    let best = null;

    for (const board of boards) {
      if ((stockLeft.get(board.id) ?? 0) <= 0) continue;
      if (board.w <= options.margin * 2 || board.h <= options.margin * 2) continue;
      const packed = options.mode === "mixed" ? packMixed(board, remaining, options) : packDirected(board, remaining, options);
      if (!packed.placements.length) continue;
      const boardArea = board.w * board.h;
      const utilization = packed.partArea / boardArea;
      const score = utilization * 100000000 + packed.partArea;
      if (!best || score > best.score) best = { ...packed, score };
    }

    if (!best) break;

    sheets.push({ ...best, index: sheets.length + 1, options: { ...options } });
    if (stockLeft.get(best.board.id) !== Infinity) {
      stockLeft.set(best.board.id, stockLeft.get(best.board.id) - 1);
    }
    remaining = remaining.filter((part) => !best.placedKeys.has(part.instance));
  }

  state.sheets = sheets;
  state.unplaced = remaining;
  state.currentSheet = 0;
  renderResults();
  saveDraft();

  const suffix = remaining.length ? `，${remaining.length} 件未排入` : "，全部小料已排入";
  showMessage(`排版完成：使用 ${sheets.length} 张大板${suffix}。`, Boolean(remaining.length));
}

function renderResults() {
  const totalBoardArea = state.sheets.reduce((sum, sheet) => sum + sheet.board.w * sheet.board.h, 0);
  const totalPartArea = state.sheets.reduce((sum, sheet) => sum + sheet.partArea, 0);
  const placedCount = state.sheets.reduce((sum, sheet) => sum + sheet.placements.length, 0);

  document.querySelector("#utilizationText").textContent = totalBoardArea
    ? `${((totalPartArea / totalBoardArea) * 100).toFixed(1)}%`
    : "-";
  document.querySelector("#sheetCountText").textContent = state.sheets.length || "-";
  document.querySelector("#placedCountText").textContent = placedCount || "-";
  document.querySelector("#unplacedCountText").textContent = state.unplaced.length || "0";

  renderCanvas();
  renderDetails();
  buildCsv();
}

function renderCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#eef2ef";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const sheet = state.sheets[state.currentSheet];
  if (!sheet) {
    ctx.fillStyle = "#66736d";
    ctx.font = "28px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("输入板材后点击开始排版", canvas.width / 2, canvas.height / 2);
    document.querySelector("#sheetLabel").textContent = "暂无排版";
    return;
  }

  const pad = 54;
  const scale = Math.min((canvas.width - pad * 2) / sheet.board.w, (canvas.height - pad * 2) / sheet.board.h);
  const drawW = sheet.board.w * scale;
  const drawH = sheet.board.h * scale;
  const ox = (canvas.width - drawW) / 2;
  const oy = (canvas.height - drawH) / 2;
  const margin = sheet.options.margin;

  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#15211d";
  ctx.lineWidth = 3;
  ctx.fillRect(ox, oy, drawW, drawH);
  ctx.strokeRect(ox, oy, drawW, drawH);

  ctx.strokeStyle = "rgba(185,71,53,0.7)";
  ctx.setLineDash([8, 8]);
  ctx.strokeRect(
    ox + margin * scale,
    oy + margin * scale,
    Math.max(0, sheet.board.w - margin * 2) * scale,
    Math.max(0, sheet.board.h - margin * 2) * scale,
  );
  ctx.setLineDash([]);

  sheet.placements.forEach((part) => {
    const x = ox + (part.x + margin) * scale;
    const y = oy + (part.y + margin) * scale;
    const w = part.w * scale;
    const h = part.h * scale;
    ctx.fillStyle = part.color;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.94)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);

    if (w > 48 && h > 25) drawPartLabel(part, x, y, w, h);
  });

  const utilization = ((sheet.partArea / (sheet.board.w * sheet.board.h)) * 100).toFixed(1);
  const modeText = sheet.options.mode === "mixed" ? "混拼" : sheet.options.direction === "horizontal" ? "仅横放" : "仅竖放";
  document.querySelector("#sheetLabel").textContent =
    `第 ${state.currentSheet + 1}/${state.sheets.length} 张：${sheet.board.name} ${sheet.board.w}×${sheet.board.h}，${modeText}，利用率 ${utilization}%`;
}

function drawPartLabel(part, x, y, w, h) {
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const nameSize = Math.max(10, Math.min(16, h / 4));
  const sizeSize = Math.max(9, Math.min(13, h / 5));
  ctx.font = `700 ${nameSize}px sans-serif`;
  ctx.fillText(part.name, x + w / 2, y + h / 2 - sizeSize / 1.5);
  ctx.font = `${sizeSize}px sans-serif`;
  ctx.fillText(`${part.w}×${part.h}`, x + w / 2, y + h / 2 + sizeSize);
}

function renderDetails() {
  const sheetDetails = document.querySelector("#sheetDetails");
  const unplacedDetails = document.querySelector("#unplacedDetails");

  if (!state.sheets.length) {
    sheetDetails.textContent = "暂无数据";
  } else {
    const byBoard = new Map();
    state.sheets.forEach((sheet) => {
      byBoard.set(sheet.board.name, (byBoard.get(sheet.board.name) || 0) + 1);
    });
    sheetDetails.innerHTML = [...byBoard.entries()]
      .map(([name, count]) => `<span class="pill">${escapeHtml(name)} × ${count}</span>`)
      .join("");
  }

  if (!state.unplaced.length) {
    unplacedDetails.textContent = state.sheets.length ? "无" : "暂无数据";
    return;
  }

  const grouped = new Map();
  state.unplaced.forEach((part) => {
    const key = `${part.name}|${part.w}|${part.h}`;
    grouped.set(key, (grouped.get(key) || 0) + 1);
  });
  unplacedDetails.innerHTML = [...grouped.entries()]
    .map(([key, count]) => {
      const [name, w, h] = key.split("|");
      return `<span class="pill">${escapeHtml(name)} ${w}×${h} × ${count}</span>`;
    })
    .join("");
}

function buildCsv() {
  const rows = [["板序", "大板", "大板长", "大板宽", "模式", "小料", "长", "宽", "X", "Y", "旋转"]];
  state.sheets.forEach((sheet) => {
    const modeText = sheet.options.mode === "mixed" ? "混拼排版" : sheet.options.direction === "horizontal" ? "定向-仅横放" : "定向-仅竖放";
    sheet.placements.forEach((part) => {
      rows.push([
        sheet.index,
        sheet.board.name,
        sheet.board.w,
        sheet.board.h,
        modeText,
        part.name,
        part.w,
        part.h,
        Math.round(part.x + sheet.options.margin),
        Math.round(part.y + sheet.options.margin),
        part.rotated ? "是" : "否",
      ]);
    });
  });
  state.lastCsv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportCsv() {
  if (!state.lastCsv) return showMessage("请先运行排版。", true);
  const blob = new Blob([`\ufeff${state.lastCsv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "板材排料结果.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function importParts() {
  const text = document.querySelector("#bulkInput").value.trim();
  if (!text) return showMessage("请先粘贴要导入的小料数据。", true);

  const imported = text
    .split(/\n+/)
    .map((line) => parsePartLine(line.trim()))
    .filter(Boolean);

  if (!imported.length) return showMessage("没有识别到有效数据，请按 名称,长,宽,数量 输入。", true);
  imported.forEach(addPartRow);
  document.querySelector("#bulkInput").value = "";
  saveDraft();
  showMessage(`已导入 ${imported.length} 行小料。`);
}

function parsePartLine(line) {
  if (!line) return null;
  const clean = line.replace(/[，；;]/g, ",").replace(/[×*]/g, "x");
  const csvParts = clean.includes(",") ? clean.split(",").map((item) => item.trim()).filter(Boolean) : null;

  if (csvParts && csvParts.length >= 4) {
    const [name, length, width, qty] = csvParts;
    return { name, length: numberValue(length), width: numberValue(width), qty: integerValue(qty) };
  }

  const compact = clean.match(/^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*x\s*(\d+)$/i);
  if (compact) {
    return { name: `小料${partsTable.children.length + 1}`, length: numberValue(compact[1]), width: numberValue(compact[2]), qty: integerValue(compact[3]) };
  }

  const tokens = clean.split(/\s+/).filter(Boolean);
  if (tokens.length >= 4) {
    const qty = tokens.pop();
    const width = tokens.pop();
    const length = tokens.pop();
    const name = tokens.join(" ");
    return { name, length: numberValue(length), width: numberValue(width), qty: integerValue(qty) };
  }

  return null;
}

function clearParts() {
  partsTable.innerHTML = "";
  state.sheets = [];
  state.unplaced = [];
  renderResults();
  saveDraft();
  showMessage("小料清单已清空。");
}

function clearAll() {
  boardsTable.innerHTML = "";
  partsTable.innerHTML = "";
  state.sheets = [];
  state.unplaced = [];
  document.querySelector("#bulkInput").value = "";
  renderResults();
  saveDraft();
  showMessage("全部数据已清空。");
}

function setMode(mode) {
  state.mode = mode;
  document.querySelector("#mixedModeBtn").classList.toggle("active", mode === "mixed");
  document.querySelector("#directedModeBtn").classList.toggle("active", mode === "directed");
  document.querySelector("#directionPanel").hidden = mode !== "directed";
  saveDraft();
}

function getDraft() {
  return {
    mode: state.mode,
    direction: document.querySelector("input[name='direction']:checked")?.value || "horizontal",
    kerf: document.querySelector("#kerfInput").value,
    margin: document.querySelector("#marginInput").value,
    boards: [...boardsTable.querySelectorAll("tr")].map((row) => {
      const inputs = row.querySelectorAll("input");
      return { name: inputs[0].value, length: inputs[1].value, width: inputs[2].value, count: inputs[3].value };
    }),
    parts: [...partsTable.querySelectorAll("tr")].map((row) => {
      const inputs = row.querySelectorAll("input");
      return { name: inputs[0].value, length: inputs[1].value, width: inputs[2].value, qty: inputs[3].value };
    }),
  };
}

function saveDraft() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(getDraft()));
}

function loadDraft() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    const draft = JSON.parse(raw);
    boardsTable.innerHTML = "";
    partsTable.innerHTML = "";
    setMode(draft.mode === "directed" ? "directed" : "mixed");
    document.querySelector("#kerfInput").value = draft.kerf ?? 3;
    document.querySelector("#marginInput").value = draft.margin ?? 5;
    const directionInput = document.querySelector(`input[name='direction'][value='${draft.direction || "horizontal"}']`);
    if (directionInput) directionInput.checked = true;
    (draft.boards || []).forEach(addBoardRow);
    (draft.parts || []).forEach(addPartRow);
    return true;
  } catch {
    return false;
  }
}

function loadExample() {
  boardsTable.innerHTML = "";
  partsTable.innerHTML = "";
  [
    { name: "2440×1220 标准板", length: 2440, width: 1220, count: "" },
    { name: "2800×1300 大板", length: 2800, width: 1300, count: 2 },
    { name: "1830×915 余料板", length: 1830, width: 915, count: 1 },
  ].forEach(addBoardRow);
  [
    { name: "柜侧板", length: 720, width: 560, qty: 8 },
    { name: "层板", length: 680, width: 320, qty: 10 },
    { name: "门板", length: 780, width: 420, qty: 6 },
    { name: "背条", length: 900, width: 120, qty: 8 },
    { name: "抽面", length: 480, width: 180, qty: 12 },
  ].forEach(addPartRow);
  saveDraft();
  optimize();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return map[char];
  });
}

function showMessage(text, isError = false) {
  const message = document.querySelector("#message");
  message.textContent = text;
  message.style.color = isError ? "var(--danger)" : "var(--muted)";
}

document.querySelector("#addBoardBtn").addEventListener("click", () => addBoardRow());
document.querySelector("#addPartBtn").addEventListener("click", () => addPartRow());
document.querySelector("#clearPartsBtn").addEventListener("click", clearParts);
document.querySelector("#clearAllBtn").addEventListener("click", clearAll);
document.querySelector("#importPartsBtn").addEventListener("click", importParts);
document.querySelector("#loadExampleBtn").addEventListener("click", loadExample);
document.querySelector("#optimizeBtn").addEventListener("click", optimize);
document.querySelector("#exportBtn").addEventListener("click", exportCsv);
document.querySelector("#mixedModeBtn").addEventListener("click", () => setMode("mixed"));
document.querySelector("#directedModeBtn").addEventListener("click", () => setMode("directed"));
document.querySelectorAll("input[name='direction'], #kerfInput, #marginInput").forEach((input) => {
  input.addEventListener("input", saveDraft);
  input.addEventListener("change", saveDraft);
});
document.querySelector("#prevSheetBtn").addEventListener("click", () => {
  if (!state.sheets.length) return;
  state.currentSheet = (state.currentSheet - 1 + state.sheets.length) % state.sheets.length;
  renderCanvas();
});
document.querySelector("#nextSheetBtn").addEventListener("click", () => {
  if (!state.sheets.length) return;
  state.currentSheet = (state.currentSheet + 1) % state.sheets.length;
  renderCanvas();
});

if (!loadDraft()) {
  addBoardRow({ name: "2440×1220 标准板", length: 2440, width: 1220, count: "" });
  addPartRow({ name: "小料1", length: 600, width: 400, qty: 4 });
}
renderResults();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
