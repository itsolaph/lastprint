/**
 * Landing-page behaviour that has nothing to do with orders: nav state, section reveals, the hero cinemagraph,
 * and a count-up helper. Imported by app.ts so everything ships in one bundle.
 */

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Run `cb` once, the first time `el` scrolls into view (immediately if observers are unavailable). */
export function onceVisible(el: Element, cb: () => void, threshold = 0.25): void {
  if (!('IntersectionObserver' in window)) {
    cb();
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        cb();
      }
    },
    { threshold },
  );
  io.observe(el);
}

/** Count from zero to `to` once. Under reduced motion the final value is written straight away. */
export function countUp(el: HTMLElement, to: number, format: (n: number) => string, ms = 1100): void {
  if (reducedMotion() || to === 0) {
    el.textContent = format(to);
    return;
  }
  const t0 = performance.now();
  const frame = (t: number): void => {
    const p = Math.min(1, (t - t0) / ms);
    const eased = 1 - (1 - p) ** 3;
    el.textContent = format(p === 1 ? to : to * eased);
    if (p < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function initNav(): void {
  const nav = document.getElementById('nav');
  const hero = document.getElementById('top');
  const toggle = document.getElementById('nav-toggle');
  if (!nav || !hero || !toggle) return;

  // Transparent over the photograph, Paper once the hero has scrolled out from under the bar.
  const sync = (): void => {
    nav.classList.toggle('solid', hero.getBoundingClientRect().bottom <= nav.offsetHeight);
  };
  sync();
  window.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('resize', sync, { passive: true });

  const setOpen = (open: boolean): void => {
    nav.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Close' : 'Menu';
  };
  toggle.addEventListener('click', () => setOpen(!nav.classList.contains('open')));
  nav.addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement).closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && nav.classList.contains('open')) {
      setOpen(false);
      toggle.focus();
    }
  });
}

function initReveal(): void {
  const targets = document.querySelectorAll('.reveal');
  if (reducedMotion() || !('IntersectionObserver' in window)) return;
  document.documentElement.classList.add('js');
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('is-in');
        io.unobserve(e.target);
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
  );
  targets.forEach((t) => io.observe(t));
}

/** The still is always underneath. The loop fades in only once it is really playing, and is removed if it cannot load. */
function initHeroVideo(): void {
  const video = document.getElementById('hero-video') as HTMLVideoElement | null;
  if (!video) return;
  const drop = (): void => video.remove();
  if (reducedMotion()) {
    drop();
    return;
  }
  video.addEventListener('error', drop);
  video.querySelector('source')?.addEventListener('error', drop);
  if (video.error || video.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) {
    drop();
    return;
  }
  const show = (): void => video.classList.add('is-playing');
  video.addEventListener('playing', show, { once: true });
  if (!video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) show();
  video.play().catch(() => {
    /* Autoplay refused: the photograph stays. */
  });
}

export function initSite(): void {
  initNav();
  initReveal();
  initHeroVideo();
}
