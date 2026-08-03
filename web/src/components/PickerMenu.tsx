import { useEffect, useRef, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { popover } from '../lib/motion';
import { FolderIcon } from './Icons';

/**
 * One "add" affordance instead of two buttons.
 *
 * Dragging handles files and folders in a single gesture, so this menu only
 * exists for the click path — where the browser genuinely forces a choice: a
 * file input can offer files *or* (with `webkitdirectory`) a folder, never both
 * in one dialog. Asking once here beats two permanent buttons.
 */
export function PickerMenu({
  open,
  align = 'left',
  onPickFiles,
  onPickFolder,
  onClose,
}: {
  open: boolean;
  align?: 'left' | 'center';
  onPickFiles: () => void;
  onPickFolder: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    // The anchor wraps both the trigger and the menu. Testing against it rather
    // than the menu alone means a click on the trigger is not treated as an
    // outside click — otherwise this would close the menu on mousedown and the
    // trigger's own click would immediately reopen it.
    const onPointerDown = (event: MouseEvent): void => {
      const anchor = ref.current?.parentElement ?? ref.current;
      if (!anchor?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const centered = align === 'center';

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={centered ? 'menu menu--center' : 'menu'}
          ref={ref}
          role="menu"
          // Grown from the corner it hangs off, so it reads as coming out of the
          // trigger rather than arriving from nowhere.
          style={{ transformOrigin: centered ? 'top center' : 'top left' }}
          variants={popover(centered ? '-50%' : 0)}
          initial="hidden"
          animate="show"
          exit="out"
        >
          <MenuItem
            icon={<FileIcon />}
            label="Choose files…"
            hint="Pick one or more files"
            onClick={() => {
              onClose();
              onPickFiles();
            }}
          />
          <MenuItem
            icon={<FolderIcon size={17} />}
            label="Choose a folder…"
            hint="Keeps the whole structure"
            onClick={() => {
              onClose();
              onPickFolder();
            }}
          />
          <p className="menu-note">Or just drag anything into the window.</p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function MenuItem({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button className="menu-item" role="menuitem" onClick={onClick} type="button">
      <span className="menu-icon">{icon}</span>
      <span>
        {label}
        <span className="hint">{hint}</span>
      </span>
    </button>
  );
}

function FileIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--muted)"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3v5h5" />
      <path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8z" />
    </svg>
  );
}
