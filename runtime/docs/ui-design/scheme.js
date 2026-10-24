/* 配色方案由页面地址决定：?scheme=light 为亮色，其余为暗色。
   令牌的亮色取值集中在 tokens.css 的 body[data-color-scheme="light"] 里。 */

const requested = new URLSearchParams(location.search).get("scheme");
document.body.dataset.colorScheme = requested === "light" ? "light" : "dark";
