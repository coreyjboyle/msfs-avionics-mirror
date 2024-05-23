import { EventBus } from '../../data/EventBus';
import { SimVarValueType } from '../../data/SimVars';
import { SimVarPublisher, SimVarPublisherEntry } from '../../instruments/BasePublishers';
import { ArrayUtils } from '../../utils/datastructures/ArrayUtils';
import { LNavTransitionMode } from './LNavTypes';

/**
 * SimVar names for LNAV data.
 */
export enum LNavVars {
  /** The current desired track, in degrees true. */
  DTK = 'L:WTAP_LNav_DTK',

  /**
   * The current crosstrack error. Negative values indicate deviation to the left, as viewed when facing in the
   * direction of the track. Positive values indicate deviation to the right.
   */
  XTK = 'L:WTAP_LNav_XTK',

  /** Whether LNAV is tracking a path. */
  IsTracking = 'L:WTAP_LNav_Is_Tracking',

  /** The global leg index of the flight plan leg LNAV is currently tracking. */
  TrackedLegIndex = 'L:WTAP_LNav_Tracked_Leg_Index',

  /** The currently active LNAV transition mode. */
  // eslint-disable-next-line @typescript-eslint/no-shadow
  TransitionMode = 'L:WTAP_LNav_Transition_Mode',

  /** The index of the vector LNAV is currently tracking. */
  TrackedVectorIndex = 'L:WTAP_LNav_Tracked_Vector_Index',

  /** The current course LNAV is attempting to steer, in degrees true. */
  CourseToSteer = 'L:WTAP_LNav_Course_To_Steer',

  /** Whether LNAV sequencing is suspended. */
  IsSuspended = 'L:WTAP_LNav_Is_Suspended',

  /**
   * The along-track distance from the start of the currently tracked leg to the plane's present position. A negative
   * distance indicates the plane is before the start of the leg.
   */
  LegDistanceAlong = 'L:WTAP_LNav_Leg_Distance_Along',

  /**
   * The along-track distance remaining in the currently tracked leg. A negative distance indicates the plane is past
   * the end of the leg.
   */
  LegDistanceRemaining = 'L:WTAP_LNav_Leg_Distance_Remaining',

  /**
   * The along-track distance from the start of the currently tracked vector to the plane's present position. A
   * negative distance indicates the plane is before the start of the vector.
   */
  VectorDistanceAlong = 'L:WTAP_LNav_Vector_Distance_Along',

  /**
   * The along-track distance remaining in the currently tracked vector. A negative distance indicates the plane is
   * past the end of the vector.
   */
  VectorDistanceRemaining = 'L:WTAP_LNav_Vector_Distance_Remaining',

  /**
   * The along-track distance from the current vector end where LNAV will sequence to the next vector.
   * A positive value means the vector will be sequenced this distance prior to the vector end.
   */
  VectorAnticipationDistance = 'L:WTAP_LNav_Vector_Anticipation_Distance',

  /** The current along-track ground speed of the airplane. */
  AlongTrackSpeed = 'L:WTAP_LNav_Along_Track_Speed'
}

/**
 * Events derived from LNAV SimVars keyed by base topic names.
 */
export interface BaseLNavSimVarEvents {
  /** The current desired track, in degrees true. */
  lnav_dtk: number;

  /**
   * The current crosstrack error, in nautical miles. Negative values indicate deviation to the left, as viewed when
   * facing in the direction of the track. Positive values indicate deviation to the right.
   */
  lnav_xtk: number;

  /** Whether LNAV is tracking a path. */
  lnav_is_tracking: boolean;

  /** The global leg index of the flight plan leg LNAV is currently tracking. */
  lnav_tracked_leg_index: number;

  /** The currently active LNAV transition mode. */
  lnav_transition_mode: LNavTransitionMode;

  /** The index of the vector LNAV is currently tracking. */
  lnav_tracked_vector_index: number;

  /** The current course LNAV is attempting to steer, in degrees true. */
  lnav_course_to_steer: number;

  /** Whether LNAV sequencing is suspended. */
  lnav_is_suspended: boolean;

  /**
   * The along-track distance from the start of the currently tracked leg to the plane's present position, in nautical
   * miles. A negative distance indicates the plane is before the start of the leg.
   */
  lnav_leg_distance_along: number;

  /**
   * The along-track distance remaining in the currently tracked leg, in nautical miles. A negative distance indicates
   * the plane is past the end of the leg.
   */
  lnav_leg_distance_remaining: number;

  /**
   * The along-track distance from the start of the currently tracked vector to the plane's present position, in
   * nautical miles. A negative distance indicates the plane is before the start of the vector.
   */
  lnav_vector_distance_along: number;

  /**
   * The along-track distance remaining in the currently tracked vector, in nautical miles. A negative distance
   * indicates the plane is past the end of the vector.
   */
  lnav_vector_distance_remaining: number;

  /**
   * The along-track distance from the current vector end where LNAV will sequence to the next vector in nautical miles.
   * A positive value means the vector will be sequenced this distance prior to the vector end.
   */
  lnav_vector_anticipation_distance: number;

  /** The current along-track ground speed of the airplane, in knots. */
  lnav_along_track_speed: number;
}

/**
 * A LNAV tracking state.
 */
export type LNavTrackingState = {
  /** Whether LNAV is currently tracking a flight path. */
  isTracking: boolean;

  /** The global index of the tracked flight plan leg. */
  globalLegIndex: number;

  /** The LNAV transition mode. */
  transitionMode: LNavTransitionMode;

  /** The index of the tracked flight path vector. */
  vectorIndex: number;

  /** Whether LNAV sequencing is suspended. */
  isSuspended: boolean;
};

/**
 * Events derived from LNAV SimVars keyed by indexed topic names.
 */
export type IndexedLNavSimVarEvents<Index extends number = number> = {
  [P in keyof BaseLNavSimVarEvents as `${P}_${Index}`]: BaseLNavSimVarEvents[P];
};

/**
 * Events published by LNAV keyed by base topic names.
 */
export interface BaseLNavEvents extends BaseLNavSimVarEvents {
  /** The current LNAV tracking state. */
  lnav_tracking_state: LNavTrackingState;

  /** Whether LNAV tracking is currently paused while awaiting lateral flight path calculations to finish. */
  lnav_is_awaiting_calc: boolean;
}

/**
 * Events published by LNAV keyed by indexed topic names.
 */
export type IndexedLNavEvents<Index extends number = number> = {
  [P in keyof BaseLNavEvents as `${P}_${Index}`]: BaseLNavEvents[P];
};

/**
 * Events published by LNAV that are derived from SimVars.
 */
export interface LNavSimVarEvents extends BaseLNavSimVarEvents, IndexedLNavSimVarEvents {
}

/**
 * Events published by LNAV.
 */
export interface LNavEvents extends BaseLNavEvents, IndexedLNavEvents {
}

/**
 * A publisher for LNAV events derived from SimVars.
 */
export class LNavSimVarPublisher extends SimVarPublisher<LNavSimVarEvents> {
  /**
   * Creates a new instance of LNavSimVarPublisher.
   * @param bus The event bus to which to publish.
   */
  public constructor(bus: EventBus) {
    const defs = ArrayUtils.flatMap(
      [
        ['lnav_dtk', { name: LNavVars.DTK, type: SimVarValueType.Degree }],
        ['lnav_xtk', { name: LNavVars.XTK, type: SimVarValueType.NM }],
        ['lnav_is_tracking', { name: LNavVars.IsTracking, type: SimVarValueType.Bool }],
        ['lnav_tracked_leg_index', { name: LNavVars.TrackedLegIndex, type: SimVarValueType.Number }],
        ['lnav_transition_mode', { name: LNavVars.TransitionMode, type: SimVarValueType.Number }],
        ['lnav_tracked_vector_index', { name: LNavVars.TrackedVectorIndex, type: SimVarValueType.Number }],
        ['lnav_course_to_steer', { name: LNavVars.CourseToSteer, type: SimVarValueType.Degree }],
        ['lnav_is_suspended', { name: LNavVars.IsSuspended, type: SimVarValueType.Bool }],
        ['lnav_leg_distance_along', { name: LNavVars.LegDistanceAlong, type: SimVarValueType.NM }],
        ['lnav_leg_distance_remaining', { name: LNavVars.LegDistanceRemaining, type: SimVarValueType.NM }],
        ['lnav_vector_distance_along', { name: LNavVars.VectorDistanceAlong, type: SimVarValueType.NM }],
        ['lnav_vector_distance_remaining', { name: LNavVars.VectorDistanceRemaining, type: SimVarValueType.NM }],
        ['lnav_vector_anticipation_distance', { name: LNavVars.VectorAnticipationDistance, type: SimVarValueType.NM }],
        ['lnav_along_track_speed', { name: LNavVars.AlongTrackSpeed, type: SimVarValueType.Knots }],
      ] as ([keyof BaseLNavSimVarEvents, SimVarPublisherEntry<any>])[],
      pair => {
        const [topic, entry] = pair;

        const indexedEntry: SimVarPublisherEntry<any> = {
          name: `${entry.name}:#index#`,
          type: entry.type,
          indexed: true,
          defaultIndex: null
        };

        return [
          pair,
          [topic, indexedEntry]
        ] as const;
      }
    );

    super(defs, bus);
  }
}