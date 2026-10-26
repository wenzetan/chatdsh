/**
 * ChatDSH 客户端面板的界面组件与样式。
 *
 * 组件只引用界面基础设计的令牌，由主题插件统一提供令牌取值；各客户端插件从本包取组件，
 * 面板的版式因此与四端主页面共用同一套规格。
 * @module @chatdsh/core-ui-kit
 */

export { UI_KIT_CSS } from './styles.ts';
export {
  Panel,
  StatusLine,
  Skeleton,
  EmptyState,
  List,
  Row,
  Badge,
  Button,
  ProgressBar,
  ErrorNote,
} from './components.tsx';
