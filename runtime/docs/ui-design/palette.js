const GROUPS = [
  {
    title: "画布与容器",
    items: [
      ["--chatdsh-bg", "应用主视口画布底色"],
      ["--chatdsh-panel", "一级面板与卡片容器"],
      ["--chatdsh-panel-2", "二级面板与左侧栏底板"],
      ["--chatdsh-code-bg", "代码块与终端背景"],
    ],
  },
  {
    title: "线条",
    items: [
      ["--chatdsh-line", "弱结构分割线"],
      ["--chatdsh-line-2", "控件外边框与强分隔"],
    ],
  },
  {
    title: "文字",
    items: [
      ["--chatdsh-ink", "标题与高亮正文"],
      ["--chatdsh-ink-2", "常规正文"],
      ["--chatdsh-muted", "辅助说明"],
      ["--chatdsh-faint", "未激活与极低对比度提示"],
    ],
  },
  {
    title: "品牌",
    items: [
      ["--chatdsh-brand", "标记与图标高亮"],
      ["--chatdsh-brand-text", "深色画布上的品牌文字"],
      ["--chatdsh-brand-fill", "主按钮填充"],
      ["--chatdsh-brand-fill-down", "主按钮按下"],
      ["--chatdsh-brand-soft", "选中底色与光晕"],
    ],
  },
  {
    title: "对话",
    items: [
      ["--chatdsh-bubble", "用户消息气泡背景"],
      ["--chatdsh-bubble-ink", "用户消息气泡文字"],
    ],
  },
  {
    title: "状态",
    items: [
      ["--chatdsh-ok", "成功与在线"],
      ["--chatdsh-warn", "警告与等待授权"],
      ["--chatdsh-danger", "错误与危险动作"],
    ],
  },
];

const root = document.body;

function readToken(name) {
  return getComputedStyle(root).getPropertyValue(name).trim();
}

function renderPalette() {
  const host = document.getElementById("palette-mount");
  host.replaceChildren();

  for (const group of GROUPS) {
    const wrap = document.createElement("div");
    wrap.className = "palette-group";

    const heading = document.createElement("h3");
    heading.textContent = group.title;
    wrap.append(heading);

    const grid = document.createElement("div");
    grid.className = "swatches";

    for (const [token, usage] of group.items) {
      const value = readToken(token);

      const card = document.createElement("div");
      card.className = "sw";

      const chip = document.createElement("div");
      chip.className = "chip";
      chip.style.background = `var(${token})`;

      const info = document.createElement("div");
      info.className = "info";

      const name = document.createElement("span");
      name.className = "tk";
      name.textContent = token;

      const use = document.createElement("span");
      use.className = "use";
      use.textContent = usage;

      const hex = document.createElement("span");
      hex.className = "hex";
      hex.textContent = value;

      info.append(name, use, hex);
      card.append(chip, info);
      grid.append(card);
    }

    wrap.append(grid);
    host.append(wrap);
  }
}

function applyScheme(scheme) {
  root.dataset.colorScheme = scheme;
  for (const button of document.querySelectorAll("[data-scheme]")) {
    button.setAttribute("aria-pressed", String(button.dataset.scheme === scheme));
  }
  renderPalette();
}

for (const button of document.querySelectorAll("[data-scheme]")) {
  button.addEventListener("click", () => applyScheme(button.dataset.scheme));
}

renderPalette();
