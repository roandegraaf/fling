import { motion } from 'motion/react';
import { draw } from '../lib/motion';

interface IconProps {
  size?: number;
  color?: string;
  strokeWidth?: number;
  className?: string;
}

function base(size: number, color: string, strokeWidth: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
}

export function UploadIcon({ size = 30, color = 'var(--accent)', strokeWidth = 1.75 }: IconProps) {
  return (
    <svg {...base(size, color, strokeWidth)}>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </svg>
  );
}

export function DownloadIcon({ size = 17, color = 'currentColor', strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, color, strokeWidth)}>
      <path d="M12 4v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </svg>
  );
}

export function CloseIcon({ size = 15, color = 'currentColor', strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, color, strokeWidth)}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

export function PlusIcon({ size = 15, color = 'currentColor', strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, color, strokeWidth)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function CheckIcon({ size = 16, color = 'var(--success)', strokeWidth = 2.25 }: IconProps) {
  return (
    <svg {...base(size, color, strokeWidth)}>
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

/** The same tick, drawn on mount. For the moments worth marking: a file landing
    and the finished link. Everywhere else use the plain `CheckIcon`. */
export function DrawnCheckIcon({
  size = 16,
  color = 'var(--success)',
  strokeWidth = 2.25,
  delay = 0,
}: IconProps & { delay?: number }) {
  return (
    <svg {...base(size, color, strokeWidth)}>
      <motion.path d="m5 13 4 4L19 7" variants={draw(delay)} initial="hidden" animate="show" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 14, color = 'var(--muted)', strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, color, strokeWidth)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 14, color = 'currentColor', strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, color, strokeWidth)}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function LockIcon({ size = 15, color = 'var(--ink)', strokeWidth = 1.75 }: IconProps) {
  return (
    <svg {...base(size, color, strokeWidth)}>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function ClockIcon({ size = 20, color = 'var(--muted)', strokeWidth = 1.75 }: IconProps) {
  return (
    <svg {...base(size, color, strokeWidth)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l2.5 2" />
    </svg>
  );
}

export function FolderIcon({ size = 16, color = 'var(--muted)', strokeWidth = 1.75 }: IconProps) {
  return (
    <svg {...base(size, color, strokeWidth)}>
      <path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.82 1.2a2 2 0 0 0 1.7.9H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

export function TrashIcon({ size = 15, color = 'currentColor', strokeWidth = 1.75 }: IconProps) {
  return (
    <svg {...base(size, color, strokeWidth)}>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7" />
    </svg>
  );
}
