import { Game } from './game.js';

async function boot() {
  const game = new Game();
  await game.init();
}

function report(error) {
  console.error('[Game startup failed]', error);
  const message = error instanceof Error ? error.message : String(error);
  document.getElementById('loading-message').textContent = '初始化失败';
  document.getElementById('loading-percent').textContent = '错误';
  const panel = document.getElementById('fatal-error');
  panel.hidden = false;
  panel.style.display = 'block';
  panel.textContent = `无法启动游戏：${message}\n\n当前地址：${location.href}\n请打开构建后的 dist/index.html；具体错误请查看浏览器控制台。`;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => boot().catch(report), { once: true });
} else {
  boot().catch(report);
}
