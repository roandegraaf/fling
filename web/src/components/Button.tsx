import type { CSSProperties, ReactNode } from 'react';

/**
 * Osmo Supply "Button 065", adapted for React.
 *
 * The animation is untouched: it is entirely CSS, driven by `--char` and
 * `--char-count` and the transitions in styles.css. What changed is who splits
 * the label. The original ships a GSAP SplitText pass on DOMContentLoaded,
 * which cannot work here — these buttons mount, unmount and swap labels with
 * React long after that event, and a split that ran once at load would leave
 * every later button unanimated. React does the same split on every render, so
 * no GSAP or CDN script is needed.
 *
 * The `data-button-065` and `data-button-065-text` hooks are kept.
 *
 * Split text is invisible to screen readers as a run of single characters, so
 * the label is repeated in `aria-label` and the split copy is hidden.
 */

const NBSP = ' ';

interface ButtonProps {
  /** Plain text — it gets split per character, so it cannot contain elements. */
  children: string;
  variant?: 'primary' | 'outline' | 'dark';
  size?: 'sm' | 'md' | 'tall';
  full?: boolean;
  /** Takes the dot's place, and slides in on hover exactly like it. */
  icon?: ReactNode;
  /** Renders an anchor instead of a button. */
  href?: string;
  type?: 'button' | 'submit';
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  full = false,
  icon,
  href,
  type = 'button',
  disabled = false,
  onClick,
  className,
}: ButtonProps) {
  const chars = [...children];

  const classes = ['btn', `btn--${variant}`, 'button-065'];
  if (icon) classes.push('button-065--icon');
  if (size === 'sm') classes.push('btn--sm');
  if (size === 'tall') classes.push('btn--tall');
  if (full) classes.push('btn--full');
  if (className) classes.push(className);

  const shared = {
    'data-button-065': '',
    className: classes.join(' '),
    style: { '--char-count': chars.length } as CSSProperties,
    'aria-label': children,
  };

  const content = (
    <>
      <span className="button-065__bg" />
      <span className="button-065__inner">
        <span className="button-065__label">
          {/* An icon is a dot with a glyph in it — same slot, same slide-in. */}
          <span className={icon ? 'button-065__dot button-065__dot--icon' : 'button-065__dot'}>
            {icon}
          </span>
          <span data-button-065-text="" className="button-065__text" aria-hidden="true">
            {chars.map((char, index) => (
              <span
                key={index}
                className="button-065__split-char"
                style={{ '--char': index + 1 } as CSSProperties}
              >
                {char === ' ' ? NBSP : char}
              </span>
            ))}
          </span>
        </span>
      </span>
    </>
  );

  if (href !== undefined) {
    return (
      <a {...shared} href={href}>
        {content}
      </a>
    );
  }

  return (
    <button {...shared} type={type} disabled={disabled} onClick={onClick}>
      {content}
    </button>
  );
}
