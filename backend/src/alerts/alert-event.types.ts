export const AlertEventTypes = {
  detectionLost: 'detection-lost',
  bedExit: 'bed-exit',
  fall: 'fall',
} as const;

export type AlertEventType =
  (typeof AlertEventTypes)[keyof typeof AlertEventTypes];

export type AlertSuppressedReason =
  | 'cooldown'
  | 'hourly_cap'
  | 'below_threshold';

export type AlertPolicyDecision =
  | { readonly kind: 'dispatch' }
  | {
      readonly kind: 'suppress';
      readonly suppressed_reason: AlertSuppressedReason;
    };
