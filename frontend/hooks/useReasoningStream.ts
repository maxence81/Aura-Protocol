"use client";

import { useState, useCallback, useRef } from 'react';
import type { ReasoningStep } from '@/types';

const REASONING_PHASES: Omit<ReasoningStep, 'status'>[] = [
  {
    id: 'intent',
    phase: 'INTENT_PARSER',
    label: 'Parsing user mandate...',
    detail: 'Extracting tokens, amounts, frequency, risk parameters',
  },
  {
    id: 'macro',
    phase: 'MACRO_AUDIT',
    label: 'Querying Pyth Network oracles...',
    detail: 'Fetching real-time prices, volatility index, correlation matrix',
  },
  {
    id: 'stylus',
    phase: 'STYLUS_SIM',
    label: 'Simulating against Rust guardrails...',
    detail: 'WASM runtime validation: selector whitelist, exposure caps, anomaly detection',
  },
  {
    id: 'committee',
    phase: 'COMMITTEE',
    label: 'Executor ↔ Auditor consensus...',
    detail: 'Cross-validating strategy proposal against risk policy',
  },
];

const STEP_DELAYS = [0, 1200, 2800, 4200];

export function useReasoningStream() {
  const [steps, setSteps] = useState<ReasoningStep[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const timersRef = useRef<NodeJS.Timeout[]>([]);

  const startStream = useCallback(() => {
    // Initialize all steps as pending
    const initialSteps: ReasoningStep[] = REASONING_PHASES.map((p) => ({
      ...p,
      status: 'pending' as const,
    }));
    setSteps(initialSteps);
    setIsStreaming(true);

    // Clear any existing timers
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];

    // Sequentially activate each step
    STEP_DELAYS.forEach((delay, index) => {
      const timer = setTimeout(() => {
        setSteps((prev) =>
          prev.map((step, i) => {
            if (i < index) return { ...step, status: 'done' as const, durationMs: STEP_DELAYS[i + 1] ? STEP_DELAYS[i + 1] - STEP_DELAYS[i] : 800 };
            if (i === index) return { ...step, status: 'active' as const };
            return step;
          })
        );
      }, delay);
      timersRef.current.push(timer);
    });
  }, []);

  const resolveStream = useCallback(() => {
    // Mark all steps as done
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];

    setSteps((prev) =>
      prev.map((step, i) => ({
        ...step,
        status: 'done' as const,
        durationMs: STEP_DELAYS[i + 1] ? STEP_DELAYS[i + 1] - STEP_DELAYS[i] : 800,
      }))
    );

    // Brief delay to show all green before clearing
    const final = setTimeout(() => {
      setIsStreaming(false);
    }, 600);
    timersRef.current.push(final);
  }, []);

  const resetStream = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    setSteps([]);
    setIsStreaming(false);
  }, []);

  return { steps, isStreaming, startStream, resolveStream, resetStream };
}
