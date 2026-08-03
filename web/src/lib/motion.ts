import type { Transition, Variants } from 'motion/react';

/**
 * The motion side of the design tokens in styles.css.
 *
 * House rule: entrances decelerate and exits accelerate, exits run at ~70% of
 * the matching entrance, and nothing but transform/opacity is animated unless a
 * row genuinely has to collapse. Keep the same values in CSS-only transitions —
 * `--ease-out` and `--dur-*` mirror this file.
 */

export const ease = {
  /** out-quint — confident deceleration, the default for anything arriving. */
  out: [0.22, 1, 0.36, 1],
  /** in-quad — anything leaving should get out of the way quickly. */
  in: [0.4, 0, 1, 1],
  inOut: [0.65, 0, 0.35, 1],
} as const;

export const duration = {
  /** Press and release. */
  tap: 0.12,
  /** Hover, colour shifts, label swaps. */
  quick: 0.18,
  /** Show / hide. */
  base: 0.26,
  /** Entrances and layout changes. */
  slow: 0.4,
} as const;

export const spring = {
  /** Everyday travel: settles without a visible overshoot. */
  soft: { type: 'spring', stiffness: 260, damping: 30, mass: 0.9 },
  /** Small elements that should feel immediate. */
  snap: { type: 'spring', stiffness: 460, damping: 34, mass: 0.7 },
  /** Long distances — the progress bar and its count-up. Overdamped on purpose:
      a progress bar that overshoots and settles back reads as a bug. */
  glide: { type: 'spring', stiffness: 120, damping: 26, mass: 1 },
} satisfies Record<string, Transition>;

export const enter: Transition = { duration: duration.slow, ease: ease.out };
/** Roughly 70% of `enter` — anything on its way out should not be dwelt on. */
export const exit: Transition = { duration: duration.quick, ease: ease.in };

/** Fade up. The single entrance used across every page. */
export const rise: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: enter },
  out: { opacity: 0, y: -6, transition: exit },
};

/** Parent of `rise` children. */
export function stagger(delayChildren = 0, staggerChildren = 0.05): Variants {
  return {
    hidden: {},
    show: { transition: { delayChildren, staggerChildren } },
    out: { transition: { staggerChildren: 0.02, staggerDirection: -1 } },
  };
}

/** The page shell arriving. Deliberately opacity-only: the content inside does
    the moving, and two things travelling at once reads as slow. */
export const stageIn: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      duration: duration.base,
      ease: ease.out,
      delayChildren: 0.05,
      staggerChildren: 0.06,
    },
  },
};

/** Swapping one card for another in the same slot. */
export const cardSwap: Variants = {
  hidden: { opacity: 0, y: 10, scale: 0.99 },
  show: { opacity: 1, y: 0, scale: 1, transition: enter },
  out: { opacity: 0, y: -8, scale: 0.99, transition: exit },
};

/**
 * A list row that collapses in and out of a bordered list.
 *
 * The row element itself carries this — no wrapper — so `:last-child {
 * border-bottom: none }` keeps matching the real last row. `show` deliberately
 * never writes a border width: that would put an inline 1px on the last row and
 * beat the stylesheet. Only the exit zeroes it, so a leaving row does not end as
 * a 1px hairline that snaps away. Pair with `overflow: hidden` on the row, and
 * pass the row's own vertical padding so `show` restores the right value.
 */
export function collapsingRow(padY: number, delay = 0): Variants {
  return {
    hidden: { opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0 },
    show: {
      opacity: 1,
      height: 'auto',
      paddingTop: padY,
      paddingBottom: padY,
      // Delay lives in the variant, not in a `transition` prop: a variant's own
      // transition wins, so a prop-level delay would be silently dropped.
      transition: { duration: duration.base, ease: ease.out, delay },
    },
    out: {
      opacity: 0,
      height: 0,
      paddingTop: 0,
      paddingBottom: 0,
      borderBottomWidth: 0,
      transition: { duration: duration.quick, ease: ease.in },
    },
  };
}

/**
 * Anchored menus, grown from the edge they hang off.
 *
 * `x` has to be carried through every state: a centred menu is positioned with
 * `left: 50%` plus `translateX(-50%)`, and motion writes the whole transform, so
 * dropping it here would slam the menu to the left edge mid-animation.
 */
export function popover(x: number | string = 0): Variants {
  return {
    hidden: { opacity: 0, y: -6, scale: 0.96, x },
    show: {
      opacity: 1,
      y: 0,
      scale: 1,
      x,
      transition: { ...spring.snap, opacity: { duration: 0.1 } },
    },
    out: {
      opacity: 0,
      y: -4,
      scale: 0.97,
      x,
      // Without this the items stay clickable while the menu fades, and a second
      // click opens two file dialogs.
      pointerEvents: 'none',
      transition: { duration: duration.tap, ease: ease.in },
    },
  };
}

/** A stroke that draws itself in. Pair with `pathLength` on a motion.path.
    Delay belongs in here rather than in a `transition` prop, which would replace
    the per-value timing wholesale. */
export function draw(delay = 0): Variants {
  return {
    hidden: { pathLength: 0, opacity: 0 },
    show: {
      pathLength: 1,
      opacity: 1,
      transition: {
        pathLength: { duration: 0.45, ease: ease.out, delay },
        opacity: { duration: 0.05, delay },
      },
    },
  };
}
