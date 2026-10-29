# 连续蒙皮人物 · 独立造型原型

这是给当前游戏选择新人物建模路线的**独立预览记录**，不是官方人物资源。用户已认可对比图右侧造型；游戏玩家、敌人和菜单现已采用该连续蒙皮路线，实际游戏入口为 `../dist/index.html`。本目录仍可独立预览旧/新造型，不替代游戏验收；物理、AI、第一人称武器保持原规则。

## 打开与构建

- 用支持 WebGL2 的 Chrome / Edge 打开本目录的 `index.html`。它是自包含 HTML，运行时不请求远程模型或贴图，也不需要启动服务器。
- 从游戏根目录运行 `node character-preview/build.mjs`，只生成本目录的 `index.html`，不覆盖 `dist/index.html`。
- 从游戏根目录运行 `node character-preview/check.mjs`，验证资源哈希、实际蒙皮顶点变化、蹲姿下降、骨长保持和释放幂等；该数学测试不替代浏览器画面检查。
- 页面支持全身/脸部近景、旋转、缩放、待机/行走/跑步/蹲姿/持枪姿势、装备显示开关及旧/新同场对比。持枪姿势只预览骨骼动作，尚未附加枪模型。

## 已换的路线与尚未完成的部分

- 新人体为作者制作的连续蒙皮网格，具有真实骨骼权重、脸部拓扑和手指。肩、肘、膝随动作变形，不再用一块块刚性方块搭出人体。
- 人体采用 Quaternius `Superhero_Male_FullBody` 免费基础体，并非专业战术服成品。运行时增加少量表面厚度和布色/粗糙度遮罩，另附原创简化头盔、背心、织带和弹匣袋。
- **布色与表面膨胀不等于完整服装版型。** 衣片、领口袖口、衣褶、鞋靴轮廓及装备细节仍是后续美术工作；不得称官方品质或写实最终模型。
- 动作库使用 Godot 的 `DEF-*` 命名，人物使用 Godot-UE 的 UE 命名。实现显式语义映射、参考姿态世界旋转校正和目标父坐标还原；只保留骨盆相对参考姿态的垂直增量，不覆盖其他目标骨骼长度，不保留水平运动漂移。
- 仅预计算本原型需要的六段动作，不将源库所有 clip 都宣称为可用重定向动作。
- 这是单人物工作室预览，不能证明全局替换 48 个角色后手机帧率达标。获得用户对造型认可后，才评估游戏接入、敌人辨识度、LOD、装备合批和贴图体积。

## 来源与许可

作者：**Quaternius**。人体与动作随包许可均为 **CC0 1.0**。

- 人体作者页面：https://quaternius.com/packs/universalbasecharacters.html
- 作者免费分发入口：https://quaternius.itch.io/universal-base-characters
- 动作作者页面：https://quaternius.com/packs/universalanimationlibrary.html
- 本次采用作者免费 **Standard** 资源，不含付费 Source 档；免费人体包只有部分基础体，不是全部宣传角色。
- 原始镜像来源与归档记录见 `assets/SOURCE-README.md`。本次通过 GitHub blob API 获取并验证固定 Git blob SHA-1：
  - 人体 glTF：`0dc21ed7952950f83bf19d3cab63110534460c54`
  - 人体 bin：`54309de6c6ccad823a8ced11056f4013b197b1c6`
  - 动作 GLB：`8ce67624ba3bb4d2ca20a4ac188fe38ceaaab97e`
- 本地原始资源保留导入时数据。预览构建会内嵌缓冲与所用图片，排除未使用的眉毛 normal 和人体 packed roughness；运行时另行修改人体几何表面厚度、服装 shader、眉色和装备。原始来源“未修改”说明不能解释为本原型运行效果完全原样。
- 人体许可：`assets/LICENSE-CHARACTERS.txt`；动作许可：`assets/LICENSE-ANIMATIONS.txt`。
- 渲染依赖 Three.js / MIT；其版权与许可全文同资产许可一起嵌入生成的 HTML。

未下载或反编译官方游戏人物，未使用付费素材，未自行提交或推送。
