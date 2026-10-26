/** 构建期把 `.css` 以内联文本载入，类型声明为字符串默认导出。 */
declare module '*.css' {
  const text: string;
  export default text;
}
