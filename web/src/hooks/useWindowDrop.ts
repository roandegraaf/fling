import { useEffect, useState } from 'react';
import { entriesFromDrop } from '../lib/picker';

/**
 * Makes the whole window a drop target rather than one small box, so a drag can
 * be released anywhere in the app.
 *
 * The entries are read synchronously here because `DataTransferItemList` is only
 * valid during the drop event itself.
 */
export function useWindowDrop(
  onDrop: (payload: ReturnType<typeof entriesFromDrop>) => void,
  enabled = true,
): boolean {
  const [isOver, setIsOver] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setIsOver(false);
      return;
    }

    // dragenter/dragleave fire for every child element, so count depth instead
    // of toggling a boolean.
    let depth = 0;

    const hasFiles = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');

    const onDragEnter = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth++;
      setIsOver(true);
    };

    const onDragOver = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };

    const onDragLeave = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsOver(false);
    };

    const onDropEvent = (event: DragEvent): void => {
      if (!event.dataTransfer) return;
      event.preventDefault();
      depth = 0;
      setIsOver(false);
      onDrop(entriesFromDrop(event.dataTransfer));
    };

    // Without these, dropping a file anywhere else navigates away from the app.
    const blockDefault = (event: DragEvent): void => {
      if (hasFiles(event)) event.preventDefault();
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDropEvent);
    document.addEventListener('dragover', blockDefault);
    document.addEventListener('drop', blockDefault);

    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDropEvent);
      document.removeEventListener('dragover', blockDefault);
      document.removeEventListener('drop', blockDefault);
    };
  }, [onDrop, enabled]);

  return isOver;
}
