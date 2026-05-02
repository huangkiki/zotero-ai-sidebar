# Zotero AI Sidebar 头像配置参考

这个文档汇总聊天头像配置的可选方案。头像配置位置：

```text
Zotero 设置 -> Zotero AI Sidebar -> 显示设置
```

可配置项：

- 我的昵称
- 我的头像
- AI 昵称
- AI 头像
- 消息按钮位置
- 消息按钮样式

## 支持的头像格式

头像输入框支持以下几类内容。

### 1. Emoji 或短文本

最简单、最稳定，推荐优先使用。

```text
🙂
🤖
📚
🔎
🧠
✍️
```

也可以使用短文本：

```text
Q
ME
AI
λ
```

### 2. 图片 URL

可以填写在线图片地址：

```text
https://example.com/avatar.png
https://example.com/avatar.jpg
https://example.com/avatar.svg
```

是否能正常显示取决于 Zotero 是否允许加载该地址，以及当前网络是否可访问。

### 3. data:image

也可以填写内嵌图片：

```text
data:image/png;base64,...
```

这种方式适合小图标，但内容较长，不太适合手动编辑。

## 推荐头像网站

### DiceBear

地址：

```text
https://www.dicebear.com/
```

最推荐。可以直接生成可用的 SVG 头像 URL，适合聊天头像。

常用风格：

```text
pixel-art
pixel-art-neutral
bottts
bottts-neutral
adventurer
lorelei
avataaars
initials
fun-emoji
```

### Iconify

地址：

```text
https://www.iconify.design/
```

适合搜索图标，例如：

```text
robot
user
brain
chat
assistant
```

### SVG Repo

地址：

```text
https://www.svgrepo.com/
```

适合搜索 SVG/PNG 图标，例如：

```text
avatar
bot
robot
assistant
reader
```

### OpenMoji

地址：

```text
https://openmoji.org/
```

适合找统一风格的 emoji 图标。

## 推荐组合

### 简单稳定组合

```text
我的头像：🙂
AI 头像：🤖
```

### 论文阅读风格

```text
我的头像：📚
AI 头像：🔎
```

### 研究助手风格

```text
我的头像：https://api.dicebear.com/9.x/lorelei/svg?seed=paper-reader
AI 头像：https://api.dicebear.com/9.x/bottts-neutral/svg?seed=zotero-agent
```

### 现代扁平头像

```text
我的头像：https://api.dicebear.com/9.x/avataaars/svg?seed=researcher
AI 头像：https://api.dicebear.com/9.x/bottts/svg?seed=AI
```

### 极简首字母

```text
我的头像：https://api.dicebear.com/9.x/initials/svg?seed=QW&backgroundColor=d1d4f9,c0aede,b6e3f4
AI 头像：https://api.dicebear.com/9.x/initials/svg?seed=AI
```

## 像素风头像

### 柔和像素头像

```text
https://api.dicebear.com/9.x/pixel-art/svg?seed=soft-reader&backgroundColor=b6e3f4,c0aede,d1d4f9
```

### 暖色像素头像

```text
https://api.dicebear.com/9.x/pixel-art/svg?seed=paper-reader&backgroundColor=ffd5dc,ffdfbf,c0aede
```

### 清爽蓝绿色

```text
https://api.dicebear.com/9.x/pixel-art/svg?seed=quiet-researcher&backgroundColor=b6e3f4,d1f4e5,c0aede
```

### 更像游戏角色

```text
https://api.dicebear.com/9.x/pixel-art/svg?seed=adventurer-reader&backgroundColor=b6e3f4
```

### 简洁像素头像

```text
https://api.dicebear.com/9.x/pixel-art-neutral/svg?seed=reader&backgroundColor=d1d4f9
```

### 稍深但不暗黑

```text
https://api.dicebear.com/9.x/pixel-art/svg?seed=night-reader&backgroundColor=243b53,486581,9fb3c8
```

## 个人头像推荐

如果希望个人头像更好看，可以优先试这几个。

### 清爽研究者

```text
https://api.dicebear.com/9.x/lorelei/svg?seed=paper-reader
```

### 柔和阅读者

```text
https://api.dicebear.com/9.x/adventurer/svg?seed=quiet-reader
```

### 像素阅读者

```text
https://api.dicebear.com/9.x/pixel-art/svg?seed=quiet-researcher&backgroundColor=b6e3f4,d1f4e5,c0aede
```

### 简洁像素阅读者

```text
https://api.dicebear.com/9.x/pixel-art-neutral/svg?seed=reader&backgroundColor=d1d4f9
```

## AI 头像推荐

### 克制机器人

```text
https://api.dicebear.com/9.x/bottts-neutral/svg?seed=zotero-agent
```

### 更明显的机器人

```text
https://api.dicebear.com/9.x/bottts/svg?seed=AI
```

### 搜索/分析风格

```text
🔎
```

### 推理脑风格

```text
🧠
```

## 建议最终配置

如果想要比较平衡、好看、稳定，可以先用这组：

```text
我的昵称：YOU
我的头像：https://api.dicebear.com/9.x/pixel-art-neutral/svg?seed=reader&backgroundColor=d1d4f9

AI 昵称：AI
AI 头像：https://api.dicebear.com/9.x/bottts-neutral/svg?seed=zotero-agent
```

如果想更简单稳定：

```text
我的昵称：YOU
我的头像：📚

AI 昵称：AI
AI 头像：🔎
```

## 使用步骤

1. 打开 Zotero 设置。
2. 进入 Zotero AI Sidebar 设置页。
3. 找到“显示设置”。
4. 将头像内容复制到“我的头像”或“AI 头像”。
5. 点击“保存显示设置”。
6. 回到侧边栏查看效果。

## 注意事项

- 留空头像时，只显示昵称。
- Emoji 和短文本最稳定。
- 网络图片可能受网络、跨域或 Zotero 安全策略影响。
- 备份配置文件会包含这些显示设置。
- 如果头像 URL 很长，建议优先使用 DiceBear 这类可复现的短 URL。
