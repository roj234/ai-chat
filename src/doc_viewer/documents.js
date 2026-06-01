export const chapterData = [
  //{ title: '概述', href: 'README.md', icon: '📋' },
  {
    title: '入门',
    icon: '🚀',
    children: [
      { title: '构建指南', href: 'documents/build.md' },
      { title: '使用指南', href: 'documents/usage.md' }
    ],
  },
  {
    title: '高级功能',
    icon: '⚡',
    children: [
      { title: '高级功能概述', href: 'documents/advanced-features.md' },
      { title: '服务端配置', href: 'documents/backend-config.md' },
      { title: 'Agent 与文件系统', href: 'documents/agent-filesystem.md' },
      { title: '自定义背景', href: 'documents/background.md' },
      { title: '生图和语音', href: 'documents/tts.md' }
    ],
  },
  {
    title: '开发',
    icon: '🔧',
    children: [
      { title: '插件开发指南', href: 'documents/plugin-development.md' },
      { title: 'API 参考', href: 'documents/api-reference.md' },
      { title: 'RPG 管线', href: 'documents/rpg-pipeline.md' }
    ],
  },
  {
    title: '其他 (标题都是梗)',
    icon: '👨',
    children: [
      { title: '体重和歧视', href: 'documents/weights_and_biases.md' },
      { title: 'V我50', href: 'documents/license.md' },
    ],
  }
]