import { NumberUnitSubject, Subject, UnitType } from '@microsoft/msfs-sdk';

/**
 * A module describing the display of the track vector.
 */
export class MapTrackVectorModule {
  /** Whether to show the track vector. */
  public readonly show = Subject.create(false);

  /** The track vector's lookahead time. */
  public readonly lookaheadTime = NumberUnitSubject.create(UnitType.SECOND.createNumber(60));
}