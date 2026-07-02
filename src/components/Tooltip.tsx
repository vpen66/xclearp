import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  position?: "top" | "bottom" | "left" | "right";
  delay?: number;
  className?: string;
}

export default function Tooltip({
  content,
  children,
  position = "top",
  delay = 150,
  className,
}: TooltipProps) {
  const [active, setActive] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<any>(null);

  const showTooltip = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setActive(true);
    }, delay);
  };

  const hideTooltip = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setActive(false);
  };

  useEffect(() => {
    if (active && triggerRef.current && tooltipRef.current) {
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const tooltipRect = tooltipRef.current.getBoundingClientRect();
      const scrollY = window.scrollY;
      const scrollX = window.scrollX;

      let top = 0;
      let left = 0;

      switch (position) {
        case "top":
          top = triggerRect.top + scrollY - tooltipRect.height - 6;
          left = triggerRect.left + scrollX + (triggerRect.width - tooltipRect.width) / 2;
          break;
        case "bottom":
          top = triggerRect.bottom + scrollY + 6;
          left = triggerRect.left + scrollX + (triggerRect.width - tooltipRect.width) / 2;
          break;
        case "left":
          top = triggerRect.top + scrollY + (triggerRect.height - tooltipRect.height) / 2;
          left = triggerRect.left + scrollX - tooltipRect.width - 6;
          break;
        case "right":
          top = triggerRect.top + scrollY + (triggerRect.height - tooltipRect.height) / 2;
          left = triggerRect.right + scrollX + 6;
          break;
      }

      // Keep within screen edges
      const margin = 8;
      if (left < margin) left = margin;
      if (left + tooltipRect.width > window.innerWidth - margin) {
        left = window.innerWidth - tooltipRect.width - margin;
      }
      if (top < margin) top = margin;
      if (top + tooltipRect.height > window.innerHeight - margin) {
        top = window.innerHeight - tooltipRect.height - margin;
      }

      setCoords({ top, left });
    }
  }, [active, position]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const animationClass = {
    top: "animate-tooltip-top",
    bottom: "animate-tooltip-bottom",
    left: "animate-tooltip-left",
    right: "animate-tooltip-right",
  }[position];

  return (
    <>
      <div
        ref={triggerRef}
        className={className || "inline-flex items-center justify-center shrink-0"}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
      >
        {children}
      </div>
      {active &&
        createPortal(
          <div
            ref={tooltipRef}
            style={{
              position: "absolute",
              top: `${coords.top}px`,
              left: `${coords.left}px`,
            }}
            className={`z-[9999] pointer-events-none select-none px-2.5 py-1.5 rounded-lg bg-gray-950/95 backdrop-blur-md border border-gray-800 text-[11px] font-medium text-gray-200 shadow-xl shadow-black/40 max-w-[280px] break-words leading-relaxed ${animationClass}`}
          >
            {content}
          </div>,
          document.body
        )}
    </>
  );
}
