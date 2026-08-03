import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { ease, duration, stageIn } from '../lib/motion';
import { navigate } from '../router';

interface PageProps {
  children: ReactNode;
  /** What sits on the right of the header. */
  action?: ReactNode;
  /** Anchor content to the top instead of centring it vertically. */
  top?: boolean;
  wide?: 'default' | 'wide' | 'admin';
}

export function Page({ children, action, top = false, wide = 'default' }: PageProps) {
  const stageClass =
    wide === 'wide' ? 'stage stage--wide' : wide === 'admin' ? 'stage stage--admin' : 'stage';

  return (
    <div className="page">
      <motion.header
        className="header"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: duration.slow, ease: ease.out }}
      >
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate('/');
          }}
        >
          <span className="brand-dot" />
          <span className="brand-name">Fling</span>
        </a>
        {action}
      </motion.header>
      <main className={top ? 'main main--top' : 'main'}>
        {/* Also the variant root for the page: children that opt in with
            `variants={rise}` inherit `hidden`/`show` and stagger behind it. */}
        <motion.div className={stageClass} variants={stageIn} initial="hidden" animate="show">
          {children}
        </motion.div>
      </main>
    </div>
  );
}

export function HeaderLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <a
      className="header-link"
      href={to}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
