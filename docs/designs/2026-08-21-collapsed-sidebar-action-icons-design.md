# 折叠侧栏操作图标设计

## 目标

折叠侧栏中的 Open Paper 当前使用彩色文档 emoji，Settings 使用系统齿轮字符。两者由操作系统字体决定外观，和同列的展开、创建按钮在颜色、描边与视觉重量上不一致；其中 Open Paper 在浅色主题里尤其偏淡，像不可用状态。此次调整只修复图标语言，不改变按钮尺寸、顺序、点击行为、Tooltip 或主题机制。

## 方案

Open Paper 改为 24×24 viewBox 的“文档加号”线性 SVG。文档轮廓说明对象是论文，加号说明动作是导入或打开新论文，比普通文档更醒目，也比文件夹图标更贴合现有本地 PDF 与 Zotero 导入流程。Settings 改为同一描边规范的线性齿轮 SVG。两枚图标统一使用圆角端点、圆角连接和 `currentColor`，由按钮现有的 `--text`、hover、focus 与主题 token 控制颜色；不引入图标依赖。

图标封装为一个小型 `SidebarActionIcon` 组件，通过 `name` 选择图形。SVG 标记为 `aria-hidden`，可访问名称继续由现有 Tooltip 注入到按钮。CSS 只负责固定 20px 视觉盒和 block 布局，避免字体基线造成的垂直偏移；36×36 按钮和命中区域保持不变。

## 验收

组件测试验证两种图标共享 `currentColor`、无填充、统一描边与隐藏语义，并分别包含文档加号和齿轮结构。随后运行前端 Vitest、TypeScript typecheck 和生产构建，并在实际折叠侧栏中检查亮色、暗色、hover 与键盘 focus 状态，确认图标清晰、居中且无布局位移。
