import type { JSX, RefObject } from "react";
import { useEffect, useRef } from "react";
import { BottomSheet } from "@astryxdesign/core/BottomSheet";
import type { BottomSheetProps } from "@astryxdesign/core/BottomSheet";

type StandaloneBottomSheetProps = Extract<BottomSheetProps, { isOpen: boolean }>;

interface BottomSheetWithReturnFocusProps extends Omit<StandaloneBottomSheetProps, "ref"> {
  returnFocusRef: RefObject<HTMLElement | null>;
}

/** Bridges Astryx's native dialog close lifecycle to a trigger that survives a replaced mobile surface. */
export function BottomSheetWithReturnFocus({
  returnFocusRef,
  ...props
}: BottomSheetWithReturnFocusProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = panelRef.current?.closest("dialog");
    if (dialog === undefined || dialog === null) return;

    const restoreFocus = (): void => {
      queueMicrotask(() => {
        const target = returnFocusRef.current;
        if (target?.isConnected) target.focus();
      });
    };

    dialog.addEventListener("close", restoreFocus);
    return () => dialog.removeEventListener("close", restoreFocus);
  }, [returnFocusRef]);

  return <BottomSheet padding={0} {...props} ref={panelRef} />;
}
