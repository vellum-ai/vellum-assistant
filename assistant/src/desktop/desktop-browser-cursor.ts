export const REMOVE_DESKTOP_CURSOR = `document.querySelector('[data-vellum-desktop-cursor]')?.remove()`;

export function desktopCursorExpression(x: number, y: number): string {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("Invalid desktop cursor coordinates");
  }
  return `(async () => {
    let cursor = document.querySelector('[data-vellum-desktop-cursor]');
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.setAttribute('data-vellum-desktop-cursor', '');
      cursor.setAttribute('aria-hidden', 'true');
      cursor.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:24px;height:30px;pointer-events:none;z-index:2147483647;';
      const shadow = cursor.attachShadow({mode:'closed'});
      shadow.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="30" viewBox="0 0 24 30"><path d="M2 2 L2 23 L8 18 L13 28 L17 26 L12 16 L21 16 Z" fill="#7057ff" stroke="white" stroke-width="2"/></svg>';
      document.documentElement.append(cursor);
    }
    const destination = 'translate(${x}px, ${y}px)';
    if (cursor.style.transform === destination) { return; }
    const animation = cursor.animate([{transform:cursor.style.transform || destination},{transform:destination}], {duration:100,easing:'ease-out'});
    cursor.style.transform = destination;
    await animation.finished;
  })()`;
}
