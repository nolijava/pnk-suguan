"use client";

import { useLayoutEffect, useRef } from "react";

interface MagtuturoHistoryScrollMetrics {
  historyYear: number;
  currentIsoYear: number;
  currentIsoWeek: number;
  weekCount: number;
  stickyWidth: number;
  weekWidths: number[];
  scrollWidth: number;
  clientWidth: number;
}

interface MagtuturoHistoryScrollProps {
  historyYear: number;
  currentIsoYear: number;
  currentIsoWeek: number;
  weekCount: number;
}

/** Dashboard-style measured, centered, clamped offset; null means no scroll. */
export function magtuturoHistoryScrollLeft(metrics: MagtuturoHistoryScrollMetrics): number | null {
  const {
    historyYear,
    currentIsoYear,
    currentIsoWeek,
    weekCount,
    stickyWidth,
    weekWidths,
    scrollWidth,
    clientWidth,
  } = metrics;

  if (historyYear !== currentIsoYear) return null;
  if (!Number.isInteger(currentIsoWeek) || currentIsoWeek < 1 || currentIsoWeek > weekCount) return null;
  if (weekWidths.length !== weekCount || scrollWidth <= clientWidth || clientWidth <= 0) return null;
  if (!Number.isFinite(stickyWidth) || stickyWidth < 0) return null;
  if (weekWidths.some((width) => !Number.isFinite(width) || width <= 0)) return null;

  const availableWeekWidth = clientWidth - stickyWidth;
  if (availableWeekWidth <= 0) return null;

  const weeksBefore = weekWidths.slice(0, currentIsoWeek - 1).reduce((total, width) => total + width, 0);
  const absoluteWeekOffset = stickyWidth + weeksBefore;
  const targetWeekWidth = weekWidths[currentIsoWeek - 1]!;
  const maxScroll = scrollWidth - clientWidth;
  // Center inside the area remaining to the right of the sticky first column,
  // so even narrow mobile viewports do not hide the target under that column.
  const centeredOffset = absoluteWeekOffset + targetWeekWidth / 2 - (stickyWidth + availableWeekWidth / 2);
  return Math.max(0, Math.min(maxScroll, centeredOffset));
}

/**
 * Position the current ISO week in the existing table after it has rendered.
 * It adds no listeners or ongoing scroll adjustments.
 */
export function MagtuturoHistoryScroll({
  historyYear,
  currentIsoYear,
  currentIsoWeek,
  weekCount,
}: MagtuturoHistoryScrollProps) {
  const positionedRef = useRef(false);

  useLayoutEffect(() => {
    if (positionedRef.current) return;
    positionedRef.current = true;

    // A manually selected historical year is never forced to the current week.
    if (historyYear !== currentIsoYear) return;

    const scroller = document.querySelector<HTMLElement>(
      ".annual-section.magtuturo-history > .annual-scroll",
    );
    if (!scroller || !Number.isInteger(currentIsoWeek) || currentIsoWeek < 1 || currentIsoWeek > weekCount) return;

    const headers = scroller.querySelectorAll<HTMLElement>("thead th");
    if (headers.length !== weekCount + 1) return;

    const stickyWidth = headers[0]?.getBoundingClientRect().width ?? 0;
    const weekWidths = Array.from(headers)
      .slice(1)
      .map((header) => header.getBoundingClientRect().width);
    if (weekWidths[currentIsoWeek - 1] === undefined) return;

    const desiredScrollLeft = magtuturoHistoryScrollLeft({
      historyYear,
      currentIsoYear,
      currentIsoWeek,
      weekCount,
      stickyWidth,
      weekWidths,
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth,
    });
    if (desiredScrollLeft !== null) scroller.scrollLeft = desiredScrollLeft;
  }, [historyYear, currentIsoYear, currentIsoWeek, weekCount]);

  return null;
}
