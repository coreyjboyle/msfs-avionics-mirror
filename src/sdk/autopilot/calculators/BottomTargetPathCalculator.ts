import { EventBus } from '../../data/EventBus';
import {
  FlightPlan, FlightPlanCalculatedEvent, FlightPlanLegEvent, FlightPlanLegIterator, FlightPlanner, FlightPlanSegmentEvent,
  FlightPlanSegmentType, LegDefinition, LegDefinitionFlags, VerticalFlightPhase
} from '../../flightplan';
import { AdcEvents } from '../../instruments';
import { BitFlags, UnitType } from '../../math';
import { AltitudeRestrictionType, LegType } from '../../navigation';
import { ReadonlySubEvent, SubEvent } from '../../sub';
import { AltitudeConstraintDetails, VerticalFlightPlan, VNavConstraint, VNavLeg } from '../VerticalNavigation';
import { VNavControlEvents } from '../vnav/VNavControlEvents';
import { VNavUtils } from '../vnav/VNavUtils';
import { VNavPathCalculator } from './VNavPathCalculator';

/**
 * Handles the calculation of the VNAV flight path for VNAV Implemetations that use only the bottom altitude of each constraint.
 * @deprecated
 */
export class BottomTargetPathCalculator implements VNavPathCalculator {

  /** The Vertical Flight Plans managed by this Path Calculator */
  private verticalFlightPlans: VerticalFlightPlan[] = [];

  /** The default or user set FPA for this path calculator */
  public flightPathAngle: number;

  /** The maximum FPA allowed for path calculator */
  public maxFlightPathAngle: number;

  /** The aircraft's current altitude in meters. */
  private currentAltitude = 0;

  /** @inheritdoc */
  public readonly planBuilt: ReadonlySubEvent<this, number> = new SubEvent<this, number>();

  /** @inheritdoc */
  public readonly vnavCalculated: ReadonlySubEvent<this, number> = new SubEvent<this, number>();

  private flightPlanIterator = new FlightPlanLegIterator();

  /**
   * Creates an instance of the VNavPathCalculator.
   * @param bus The EventBus to use with this instance.
   * @param flightPlanner The flight planner to use with this instance.
   * @param primaryPlanIndex The primary flight plan index to use to calculate a path from.
   * @param defaultFpa The default FPA for this path calculator.
   * @param defaultMaxFpa The default maximum FPA value for this path calculator.
   */
  constructor(private readonly bus: EventBus,
    private readonly flightPlanner: FlightPlanner,
    private readonly primaryPlanIndex: number,
    defaultFpa: number,
    defaultMaxFpa: number) {

    this.flightPathAngle = defaultFpa;
    this.maxFlightPathAngle = defaultMaxFpa;

    // While these events and classes were refactored to handle more that one plan, in the case of the bottom target path calculator,
    // I have inhibited processing anything but plan index 0.

    this.flightPlanner.onEvent('fplCreated').handle(e => e.planIndex === 0 && this.createVerticalPlan(e.planIndex));

    this.flightPlanner.onEvent('fplCopied').handle(e => e.targetPlanIndex === 0 && this.onPlanChanged(e.targetPlanIndex));

    this.flightPlanner.onEvent('fplLoaded').handle(e => e.planIndex === 0 && this.onPlanChanged(e.planIndex));

    this.flightPlanner.onEvent('fplLegChange').handle(e => e.planIndex === 0 && this.onPlanChanged(e.planIndex, e));

    this.flightPlanner.onEvent('fplSegmentChange').handle(e => e.planIndex === 0 && this.onPlanChanged(e.planIndex, undefined, e));

    this.flightPlanner.onEvent('fplIndexChanged').handle(e => e.planIndex === 0 && this.onPlanChanged(e.planIndex));

    this.flightPlanner.onEvent('fplCalculated').handle(e => e.planIndex === 0 && this.onPlanCalculated(e));

    bus.getSubscriber<AdcEvents>().on('indicated_alt').whenChangedBy(1).handle(alt => this.currentAltitude = UnitType.FOOT.convertTo(alt, UnitType.METER));

    bus.getSubscriber<VNavControlEvents>().on('vnav_set_current_fpa').handle(this.setFpaHandler);
  }

  /** @inheritdoc */
  public getVerticalFlightPlan(planIndex: number): VerticalFlightPlan {
    if (this.verticalFlightPlans[planIndex] !== undefined) {
      return this.verticalFlightPlans[planIndex];
    } else {
      return this.createVerticalPlan(planIndex);
    }
  }

  /** @inheritdoc */
  public createVerticalPlan(planIndex: number): VerticalFlightPlan {
    const verticalFlightPlan: VerticalFlightPlan = {
      planIndex,
      length: 0,
      constraints: [],
      segments: [],
      destLegIndex: undefined,
      fafLegIndex: undefined,
      firstDescentConstraintLegIndex: undefined,
      lastDescentConstraintLegIndex: undefined,
      missedApproachStartIndex: undefined,
      currentAlongLegDistance: undefined,
      verticalDirectIndex: undefined,
      verticalDirectFpa: undefined,
      planChanged: true
    };

    this.verticalFlightPlans[planIndex] = verticalFlightPlan;

    return this.verticalFlightPlans[planIndex];
  }

  /** @inheritdoc */
  public setCurrentAlongLegDistance(planIndex: number, distance: number): void {
    const verticalPlan = this.getVerticalFlightPlan(planIndex);

    verticalPlan.currentAlongLegDistance = distance;
  }

  /** @inheritdoc */
  public getTargetConstraintIndex(planIndex: number, globalLegIndex: number): number {
    const verticalPlan = this.getVerticalFlightPlan(planIndex);

    const priorConstraintIndex = VNavUtils.getPriorConstraintIndexFromLegIndex(verticalPlan, globalLegIndex);
    const priorConstraint = verticalPlan.constraints[priorConstraintIndex];
    if (priorConstraint && priorConstraint.nextVnavEligibleLegIndex && globalLegIndex < priorConstraint.nextVnavEligibleLegIndex) {
      return priorConstraintIndex;
    }

    let i = verticalPlan.constraints.length - 1;
    while (i >= 0) {
      const constraint = verticalPlan.constraints[i];
      if (globalLegIndex <= constraint.index && constraint.isTarget && !constraint.isBeyondFaf) {
        return i;
      }

      i--;
    }

    return -1;
  }

  /** @inheritdoc */
  public getTargetConstraint(planIndex: number, globalLegIndex: number): VNavConstraint | undefined {
    const verticalPlan = this.getVerticalFlightPlan(planIndex);
    return verticalPlan.constraints[this.getTargetConstraintIndex(planIndex, globalLegIndex)];
  }

  /** @inheritdoc */
  public getTargetAltitude(planIndex: number, globalLegIndex: number): number | undefined {
    return this.getTargetConstraint(planIndex, globalLegIndex)?.targetAltitude;
  }

  /** @inheritdoc */
  public getFlightPhase(planIndex: number): VerticalFlightPhase {
    const verticalPlan = this.getVerticalFlightPlan(planIndex);

    if (this.flightPlanner.hasFlightPlan(0)) {
      const plan = this.flightPlanner.getFlightPlan(0);
      const index = VNavUtils.getConstraintLegIndexFromLegIndex(verticalPlan, plan.activeLateralLeg);
      if (index > -1) {
        const constraint = VNavUtils.getConstraintFromLegIndex(verticalPlan, index);
        switch (constraint?.type) {
          case 'climb':
          case 'missed':
            return VerticalFlightPhase.Climb;
        }
      }
    }
    return VerticalFlightPhase.Descent;
  }

  /** @inheritdoc */
  public getCurrentConstraintAltitude(planIndex: number, globalLegIndex: number): number | undefined {
    const verticalPlan = this.getVerticalFlightPlan(planIndex);

    const priorConstraint = VNavUtils.getPriorConstraintFromLegIndex(verticalPlan, globalLegIndex);
    const currentConstraint = VNavUtils.getConstraintFromLegIndex(verticalPlan, globalLegIndex);
    if (priorConstraint && priorConstraint.nextVnavEligibleLegIndex && globalLegIndex < priorConstraint.nextVnavEligibleLegIndex) {
      return priorConstraint.targetAltitude;
    } else {
      return currentConstraint && currentConstraint.targetAltitude ? currentConstraint.targetAltitude : undefined;
    }
  }

  /** @inheritdoc */
  public getCurrentConstraintDetails(planIndex: number, globalLegIndex: number): AltitudeConstraintDetails {
    const verticalPlan = this.getVerticalFlightPlan(planIndex);

    const priorConstraint = VNavUtils.getPriorConstraintFromLegIndex(verticalPlan, globalLegIndex);
    const currentConstraint = VNavUtils.getConstraintFromLegIndex(verticalPlan, globalLegIndex);
    if (priorConstraint && priorConstraint.nextVnavEligibleLegIndex && globalLegIndex < priorConstraint.nextVnavEligibleLegIndex) {
      return { type: AltitudeRestrictionType.At, altitude: Math.round(UnitType.METER.convertTo(priorConstraint.targetAltitude, UnitType.FOOT)) };
    } else if (currentConstraint && currentConstraint.targetAltitude) {
      return { type: AltitudeRestrictionType.At, altitude: Math.round(UnitType.METER.convertTo(currentConstraint.targetAltitude, UnitType.FOOT)) };
    } else {
      return { type: AltitudeRestrictionType.Unused, altitude: 0 };
    }
  }

  /** @inheritdoc */
  public getNextConstraintAltitude(planIndex: number, globalLegIndex: number): number | undefined {
    const verticalPlan = this.getVerticalFlightPlan(planIndex);

    const currentConstraint = VNavUtils.getConstraintFromLegIndex(verticalPlan, globalLegIndex);
    return currentConstraint && currentConstraint.targetAltitude ? currentConstraint.targetAltitude : undefined;
  }

  /** @inheritdoc */
  public getNextRestrictionForFlightPhase(planIndex: number, activeLateralLeg: number): VNavConstraint | undefined {
    const verticalPlan = this.getVerticalFlightPlan(planIndex);

    const currentConstraint = VNavUtils.getConstraintFromLegIndex(verticalPlan, activeLateralLeg);
    if (currentConstraint) {
      const currentConstraintIndex = verticalPlan.constraints.indexOf(currentConstraint);

      if (currentConstraintIndex > -1) {

        if (this.getFlightPhase(planIndex) === VerticalFlightPhase.Climb) {
          for (let i = currentConstraintIndex; i >= 0; i--) {
            const constraint = verticalPlan.constraints[i];
            if (constraint.type === 'climb' || constraint.type === 'missed') {
              if (constraint.minAltitude > Number.NEGATIVE_INFINITY) {
                return constraint;
              }
            } else {
              return undefined;
            }
          }
        } else {
          for (let i = currentConstraintIndex; i >= 0; i--) {
            const constraint = verticalPlan.constraints[i];
            if (constraint.type === 'descent' || constraint.type === 'direct' || constraint.type === 'manual') {
              if (constraint.maxAltitude < Number.POSITIVE_INFINITY) {
                return constraint;
              }
            } else {
              return undefined;
            }
          }
        }
      }
    }

    return undefined;
  }

  /** @inheritdoc */
  public activateVerticalDirect(planIndex: number, constraintGlobalLegIndex: number): void {
    const verticalPlan = this.getVerticalFlightPlan(planIndex);

    verticalPlan.verticalDirectIndex = constraintGlobalLegIndex;
    const plan = this.flightPlanner.getFlightPlan(this.primaryPlanIndex);
    this.buildVerticalPath(plan, verticalPlan, verticalPlan.verticalDirectIndex);
  }

  /**
   * Sets an FPA on the current constraint when an event is received from the VNAV Profile Window via the bus.
   * @param fpa The FPA to set the constraint to manually.
   */
  private setFpaHandler = (fpa: number): void => {
    const lateralPlan = this.flightPlanner.getFlightPlan(this.primaryPlanIndex);
    const verticalPlan = this.verticalFlightPlans[this.primaryPlanIndex];
    const constraint = VNavUtils.getConstraintFromLegIndex(verticalPlan, lateralPlan.activeLateralLeg);
    const leg = lateralPlan.tryGetLeg(lateralPlan.activeLateralLeg);
    if (leg && constraint) {
      leg.verticalData.fpa = fpa;
      constraint.fpa = fpa;
      constraint.type = 'manual';
      this.computeVnavPath(verticalPlan, lateralPlan);
    }
  };

  /**
   * Sets planChanged to true to flag that a plan change has been received over the bus.
   * @param planIndex The Plan Index that changed.
   * @param legChangeEvent The FlightPlanLegEvent, if any.
   * @param segmentChangeEvent The FlightPlanSegmentEvent, if any.
   */
  private onPlanChanged(planIndex: number, legChangeEvent?: FlightPlanLegEvent, segmentChangeEvent?: FlightPlanSegmentEvent): void {

    const plan = this.flightPlanner.getFlightPlan(planIndex);
    const verticalPlan = this.getVerticalFlightPlan(planIndex);

    if (verticalPlan.verticalDirectIndex !== undefined) {
      if (legChangeEvent !== undefined) {
        const globalIndex = plan.getSegment(legChangeEvent.segmentIndex).offset + legChangeEvent.legIndex;
        if (globalIndex <= verticalPlan.verticalDirectIndex) {
          verticalPlan.verticalDirectIndex = undefined;
        }
      } else if (segmentChangeEvent !== undefined) {
        const verticalDirectSegmentIndex = plan.getSegmentIndex(verticalPlan.verticalDirectIndex);
        if (segmentChangeEvent.segmentIndex <= verticalDirectSegmentIndex) {
          verticalPlan.verticalDirectIndex = undefined;
        }
      }
    }

    verticalPlan.planChanged = true;
    verticalPlan.currentAlongLegDistance = undefined;
  }

  /**
   * Method fired on a flight plan change event to rebuild the vertical path.
   * @param event The Flight Plan Calculated Event
   */
  private onPlanCalculated(event: FlightPlanCalculatedEvent): void {
    const lateralPlan = this.flightPlanner.getFlightPlan(event.planIndex);
    const verticalPlan = this.getVerticalFlightPlan(event.planIndex);

    if (verticalPlan.planChanged) {
      this.buildVerticalPath(lateralPlan, verticalPlan, verticalPlan.verticalDirectIndex);
    } else {
      this.computeVnavPath(verticalPlan, lateralPlan);
    }
  }

  /**
   * Resets the VNAV plan segments, legs, and constraints based on the new plan.
   * @param lateralPlan The Lateral Flight Plan.
   * @param verticalPlan The Vertical Flight Plan.
   * @param verticalDirectIndex The vertical direct index, if any
   */
  private buildVerticalPath(lateralPlan: FlightPlan, verticalPlan: VerticalFlightPlan, verticalDirectIndex?: number): void {
    verticalPlan.fafLegIndex = VNavUtils.getFafIndexReverse(lateralPlan, this.flightPlanIterator);
    verticalPlan.constraints.length = 0;
    let currentConstraintAlt = 0;
    let priorConstraintAlt = Number.POSITIVE_INFINITY;
    let pathIsDirect = false;
    let constraintContainsManualLeg = false;
    let currentConstraint = this.createConstraint(0, 0, '$DEFAULT', 'descent');
    verticalPlan.segments.length = 0;
    verticalPlan.destLegIndex = Math.max(0, lateralPlan.length - 1);
    verticalPlan.missedApproachStartIndex = verticalPlan.destLegIndex;
    const directToData = lateralPlan.directToData;
    const directToGlobalLegIndex = directToData.segmentIndex > 0 && directToData.segmentLegIndex > -1 ?
      lateralPlan.getSegment(directToData.segmentIndex).offset + directToData.segmentLegIndex : -1;

    // Iterate forward through the plan to build the constraints
    for (const segment of lateralPlan.segments()) {
      // Add the plan segments to the VNav Path Calculator Segments
      verticalPlan.segments[segment.segmentIndex] = {
        offset: segment.offset,
        legs: []
      };

      let missedApproachFound = false;

      for (let legIndex = 0; legIndex < segment.legs.length; legIndex++) {
        const planLeg = segment.legs[legIndex];
        const leg = this.createLeg(segment.segmentIndex, legIndex, planLeg.name ?? '', planLeg.calculated?.distanceWithTransitions ?? undefined);
        const globalLegIndex = segment.offset + legIndex;

        switch (planLeg.leg.type) {
          case LegType.CI:
          case LegType.VI:
          case LegType.FM:
          case LegType.VM:
            constraintContainsManualLeg = true;
        }

        //Check if the leg is part of the missed approach, and set the missed approach start and dest leg indexes.
        if (segment.segmentType === FlightPlanSegmentType.Approach && !missedApproachFound && BitFlags.isAll(planLeg.flags, LegDefinitionFlags.MissedApproach)) {
          verticalPlan.missedApproachStartIndex = globalLegIndex;
          verticalPlan.destLegIndex = Math.max(0, globalLegIndex - 1);
          missedApproachFound = true;
        }

        //Check if we are in a vertical direct
        if (verticalDirectIndex !== undefined && verticalDirectIndex === globalLegIndex) {
          currentConstraint.type = 'direct';
          pathIsDirect = true;
        }

        //Check if we in a direct to (or approach is activated)
        if (directToData.segmentIndex === segment.segmentIndex && legIndex === directToData.segmentLegIndex + 3
          && BitFlags.isAll(planLeg.flags, LegDefinitionFlags.DirectTo)) {
          currentConstraint.type = 'direct';
          pathIsDirect = true;
          currentConstraint.legs.length = 0;
          if (verticalPlan.constraints.length > 0) {
            verticalPlan.constraints.length = 0;
          }
        }

        // Check if this leg has a constraint
        let legIsConstraint = false;
        if (segment.segmentType !== FlightPlanSegmentType.Origin && segment.segmentType !== FlightPlanSegmentType.Departure &&
          planLeg.verticalData && planLeg.verticalData.altDesc !== AltitudeRestrictionType.Unused && globalLegIndex <= verticalPlan.fafLegIndex && !missedApproachFound) {

          currentConstraintAlt = this.getConstraintAltitude(planLeg);

          // If the current constraint altitude is higher than the prior constraint altitude,
          // then mark it as invalid and don't process the constraint.
          const tempConstraintDistance = VNavUtils.getConstraintDistanceFromConstraint(currentConstraint);
          const fpaTempValue = VNavUtils.getFpa(leg.distance + tempConstraintDistance, Math.abs(currentConstraintAlt - priorConstraintAlt));
          const currentWithPrecision = Math.round(currentConstraintAlt * 10) / 10;
          const priorWithPrecision = Math.round(priorConstraintAlt * 10) / 10;
          if ((verticalDirectIndex !== undefined && verticalDirectIndex > globalLegIndex) ||
            (globalLegIndex <= directToGlobalLegIndex)) {
            legIsConstraint = false;
          } else if (currentWithPrecision > priorWithPrecision || (!constraintContainsManualLeg &&
            (priorConstraintAlt < Number.POSITIVE_INFINITY && fpaTempValue > 6))) {
            leg.invalidConstraintAltitude = currentConstraintAlt;
          } else {
            legIsConstraint = true;
          }
        }

        // Add the leg to the current constraint.
        currentConstraint.legs.unshift(leg);
        verticalPlan.segments[segment.segmentIndex].legs.push(leg);

        switch (planLeg.leg.type) {
          case LegType.HA:
          case LegType.HM:
          case LegType.HF:
          case LegType.VM:
          case LegType.FM:
          case LegType.Discontinuity:
          case LegType.ThruDiscontinuity:
            leg.isEligible = false;

            if (verticalPlan.constraints.length > 0) {
              const priorConstraint = verticalPlan.constraints[0];
              priorConstraint.isPathEnd = true;
              priorConstraint.isTarget = true;
              priorConstraint.nextVnavEligibleLegIndex = globalLegIndex + 1;
            }
        }

        const isLastLeg = globalLegIndex === lateralPlan.length - 1;

        // If the current leg has a valid constraint, set the constraint details on the current constraint,
        // then add a new empty constraint
        if (legIsConstraint || isLastLeg) {

          currentConstraint.index = globalLegIndex;
          currentConstraint.name = isLastLeg ? '$DEST' : planLeg.name ?? '';
          currentConstraint.type = isLastLeg ? 'dest' : pathIsDirect ? 'direct' : 'descent';

          //If we happen to be in the destination segment (i.e. the end of the plan)
          //set the alt to the next constraint alt so that the segment is flat
          currentConstraint.targetAltitude = globalLegIndex > verticalPlan.fafLegIndex ? priorConstraintAlt : currentConstraintAlt;
          currentConstraint.minAltitude = currentConstraint.targetAltitude;
          currentConstraint.maxAltitude = currentConstraint.targetAltitude;

          // TODO: Is this still needed?
          if (pathIsDirect) {
            currentConstraint.isTarget = true;
          }

          // If this is the FAF, set target and path end
          if (globalLegIndex === verticalPlan.fafLegIndex) {
            currentConstraint.isTarget = true;
            currentConstraint.isPathEnd = true;
          }

          if (planLeg.verticalData.fpa && lateralPlan.activeLateralLeg <= globalLegIndex
            && lateralPlan.activeLateralLeg >= currentConstraint.legs[currentConstraint.legs.length - 1].legIndex) {
            currentConstraint.fpa = planLeg.verticalData.fpa;
            currentConstraint.type = 'manual';
          } else if (planLeg.verticalData.fpa) {
            planLeg.verticalData.fpa = undefined;
          }

          // Add the current constraint to the array of constraints in reverse order
          if (!isLastLeg || (isLastLeg && verticalPlan.fafLegIndex === lateralPlan.length - 1)) {
            verticalPlan.constraints.unshift(currentConstraint);
            constraintContainsManualLeg = false;
            pathIsDirect = false;
          }

          // Set the prior constraint altitude from the current constraint before creating a new
          priorConstraintAlt = currentConstraint.targetAltitude;

          // Create a new empty constraint
          if (!isLastLeg) {
            currentConstraint = this.createConstraint(lateralPlan.length - 1, 0, '$DEFAULT', 'descent');
          }
        }
      }
    }

    verticalPlan.length = lateralPlan.length;

    verticalPlan.firstDescentConstraintLegIndex = verticalPlan.constraints[VNavUtils.getFirstDescentConstraintIndex(verticalPlan)]?.index;
    verticalPlan.lastDescentConstraintLegIndex = verticalPlan.constraints[VNavUtils.getLastDescentConstraintIndex(verticalPlan)]?.index;

    verticalPlan.planChanged = false;

    this.notifyBuilt(verticalPlan.planIndex);

    this.computeVnavPath(verticalPlan, lateralPlan);
  }


  /**
   * Computes the VNAV descent path.
   * @param verticalPlan The Vertical Flight Plan
   * @param lateralPlan The Lateral Flight Plan
   */
  private computeVnavPath(verticalPlan: VerticalFlightPlan, lateralPlan: FlightPlan): void {

    this.fillLegAndConstraintDistances(verticalPlan, lateralPlan);

    if (this.needRevalidateConstraints(verticalPlan, lateralPlan) || !this.computeFlightPathAngles(verticalPlan)) {
      this.buildVerticalPath(lateralPlan, verticalPlan, verticalPlan.verticalDirectIndex);
      return;
    }

    for (let constraintIndex = 0; constraintIndex < verticalPlan.constraints.length; constraintIndex++) {
      const constraint = verticalPlan.constraints[constraintIndex];

      if (constraint.type === 'descent' || constraint.type === 'direct' || constraint.type === 'manual' || constraint.type === 'dest') {

        let altitude = constraint.targetAltitude;

        for (let legIndex = 0; legIndex < constraint.legs.length; legIndex++) {
          const leg = constraint.legs[legIndex];
          leg.fpa = verticalPlan.fafLegIndex !== undefined && constraint.index <= verticalPlan.fafLegIndex ? constraint.fpa : 0;
          leg.altitude = altitude;

          altitude += VNavUtils.altitudeForDistance(leg.fpa, leg.distance);

          if (legIndex === 0) {
            leg.isAdvisory = false;
          } else {
            leg.isAdvisory = true;
          }

          if (legIndex === 0 && constraint.isTarget) {
            leg.isBod = true;
          } else {
            leg.isBod = false;
          }
        }
      }
    }

    this.notifyCalculated(verticalPlan.planIndex);
  }

  /**
   * Fills the VNAV plan leg and constraint segment distances.
   * @param verticalPlan The Vertical Flight Plan
   * @param lateralPlan The Lateral Flight Plan
   */
  private fillLegAndConstraintDistances(verticalPlan: VerticalFlightPlan, lateralPlan: FlightPlan): void {

    this.flightPlanIterator.iterateReverse(lateralPlan, cursor =>
      verticalPlan.segments[cursor.segment.segmentIndex].legs[cursor.legIndex].distance = cursor.legDefinition?.calculated?.distanceWithTransitions ?? 0);

    for (let constraintIndex = 0; constraintIndex < verticalPlan.constraints.length; constraintIndex++) {
      const constraint = verticalPlan.constraints[constraintIndex];
      constraint.distance = VNavUtils.getConstraintDistanceFromConstraint(constraint);
    }
  }

  /**
   * Computes the flight path angles for each constraint segment.
   * @param verticalPlan The Vertical Flight Plan.
   * @returns Whether the flight path angles were computed.
   */
  private computeFlightPathAngles(verticalPlan: VerticalFlightPlan): boolean {

    let isCurrentlyDirect = false;

    for (let i = 0; i < verticalPlan.constraints.length; i++) {
      const currentConstraint = verticalPlan.constraints[i];
      const nextConstraint = verticalPlan.constraints[i + 1];

      currentConstraint.legs.forEach((leg) => {
        if (leg.invalidConstraintAltitude) {
          return false;
        }
      });

      if (currentConstraint.type === 'manual') {
        // If we have manually set an FPA on this constraint, do not calculate the FPA.
        continue;
      }

      if (currentConstraint.type !== 'direct') {
        currentConstraint.fpa = this.flightPathAngle;
      }

      currentConstraint.isTarget = isCurrentlyDirect ? false : true;

      if (currentConstraint.index === verticalPlan.fafLegIndex) {
        currentConstraint.isTarget = true;
      }

      if (verticalPlan.fafLegIndex !== undefined && currentConstraint.index > verticalPlan.fafLegIndex) {
        currentConstraint.isBeyondFaf = true;
      }

      if (nextConstraint !== undefined && nextConstraint.type !== 'climb' && !nextConstraint.isPathEnd) {
        const directFpa = VNavUtils.getFpa(currentConstraint.distance, nextConstraint.targetAltitude - currentConstraint.targetAltitude);
        const endAltitude = currentConstraint.targetAltitude + VNavUtils.altitudeForDistance(this.flightPathAngle, currentConstraint.distance);

        //If going direct is within a half a degree of the default FPA, or if we were unable to meet
        //the next constraint, go direct
        if (Math.abs(directFpa - this.flightPathAngle) <= 0.5 || endAltitude < nextConstraint.targetAltitude) {

          // Check if the FPA will exceed the max flight path angle and if so, invalidate the constraint.
          if (directFpa > this.maxFlightPathAngle && i !== 0) {
            return false;
          } else {
            currentConstraint.fpa = directFpa;
            isCurrentlyDirect = true;
          }

        } else if (currentConstraint.targetAltitude === nextConstraint.targetAltitude || currentConstraint.isBeyondFaf) {
          currentConstraint.fpa = 0;
          isCurrentlyDirect = false;
        } else {
          isCurrentlyDirect = false;
        }
      } else {
        isCurrentlyDirect = false;
      }

      //If the constraint is a direct, check if an FPA > 3 is required and, if so, attempt to set the max FPA
      if (currentConstraint.type === 'direct' && currentConstraint.fpa === 0 && verticalPlan.currentAlongLegDistance !== undefined) {
        const plan = this.flightPlanner.getActiveFlightPlan();
        const legsToConstraint = currentConstraint.index - plan.activeLateralLeg;
        let distance = 0;

        for (let l = 0; l <= legsToConstraint; l++) {
          const leg = currentConstraint.legs[l];
          distance += leg.distance;
        }

        distance -= verticalPlan.currentAlongLegDistance;

        const fpaRequired = VNavUtils.getFpa(distance, 50 + this.currentAltitude - currentConstraint.targetAltitude);
        //If the constraint is a vertical direct, don't clamp at 3 degrees
        const minFpaClamp = verticalPlan.verticalDirectIndex === currentConstraint.index ? 0 : 3;
        currentConstraint.fpa = Utils.Clamp(fpaRequired, minFpaClamp, this.maxFlightPathAngle);
      }
    }
    return true;
  }

  /** @inheritdoc */
  public getFirstDescentConstraintAltitude(planIndex: number): number | undefined {
    const verticalPlan = this.getVerticalFlightPlan(planIndex);

    if (verticalPlan.constraints.length > 0) {
      for (let i = verticalPlan.constraints.length - 1; i >= 0; i--) {
        const constraint = verticalPlan.constraints[i];
        if (constraint.type !== 'climb' && constraint.type !== 'missed') {
          return constraint.targetAltitude;
        }
      }
    }
    return undefined;
  }

  /**
   * Gets the constraint for a leg altitude restriction.
   * @param leg The leg to get the constraint for.
   * @returns The altitude constraint.
   */
  private getConstraintAltitude(leg: LegDefinition): number {
    switch (leg.verticalData.altDesc) {
      case AltitudeRestrictionType.At:
      case AltitudeRestrictionType.AtOrAbove:
      case AltitudeRestrictionType.AtOrBelow:
        return leg.verticalData.altitude1;
      case AltitudeRestrictionType.Between:
        return leg.verticalData.altitude2;
    }
    return Number.POSITIVE_INFINITY;
  }

  /**
   * Checks whether any previously invalid constraints in the flight plan have become valid.
   * @param verticalPlan The Vertical Flight Plan.
   * @param lateralPlan The Lateral Flight Plan.
   * @returns Whether any previously invalid constraints in the flight plan have become valid.
   */
  private needRevalidateConstraints(verticalPlan: VerticalFlightPlan, lateralPlan: FlightPlan): boolean {
    if (verticalPlan.constraints.length > 0 && lateralPlan.length > 0) {
      const lastGlobalLegIndex = Math.max(0, lateralPlan.length - 1);

      for (let l = 0; l <= lastGlobalLegIndex; l++) {
        const verticalLeg = VNavUtils.getVerticalLegFromPlan(verticalPlan, l);
        if (verticalLeg.invalidConstraintAltitude !== undefined) {
          const previousConstraintIndex = VNavUtils.getConstraintIndexFromLegIndex(verticalPlan, l) + 1;
          const previousConstraint = verticalPlan.constraints[previousConstraintIndex];
          const lateralLeg = lateralPlan.tryGetLeg(l);
          if (lateralLeg !== null) {
            const constraintAltitude = this.getConstraintAltitude(lateralLeg);
            if (isFinite(constraintAltitude)) {
              const proposedConstraint = this.createConstraint(l, constraintAltitude, verticalLeg.name, 'descent');
              proposedConstraint.distance = VNavUtils.getConstraintDistanceFromLegs(proposedConstraint, previousConstraint, verticalPlan);
              if (
                !BottomTargetPathCalculator.isConstraintHigherThanPriorConstraint(previousConstraint, proposedConstraint) &&
                !BottomTargetPathCalculator.doesConstraintRequireInvalidFpa(previousConstraint, proposedConstraint, verticalPlan, this.maxFlightPathAngle)
              ) {
                return true;
              }
            }
          }
        }
      }
    }
    return false;
  }

  /**
   * Checks whether a leg constriant is a descent constraint and is higher than the prior descent leg constraint.
   * @param previousConstrant The previous VNav Constraint.
   * @param currentConstraint The current VNav Constraint.
   * @returns Whether the current constraint is higher than the previous constraint.
   */
  private static isConstraintHigherThanPriorConstraint(previousConstrant: VNavConstraint, currentConstraint: VNavConstraint): boolean {
    const currentWithPrecision = Math.round(currentConstraint.targetAltitude * 10) / 10;
    const priorWithPrecision = Math.round(previousConstrant.targetAltitude * 10) / 10;

    if (currentWithPrecision > priorWithPrecision) {
      return true;
    }

    return false;
  }

  /**
   * Checks whether a leg constraint requires an FPA greater than the max allowed value.
   * @param previousConstrant The previous VNavConstraint.
   * @param currentConstraint The VNavConstraint being evaluated.
   * @param verticalPlan The vertical flight plan.
   * @param maxFpa The maximum FPA allowed.
   * @returns Whether this constraint requires an invalid FPA.
   */
  private static doesConstraintRequireInvalidFpa(
    previousConstrant: VNavConstraint,
    currentConstraint: VNavConstraint,
    verticalPlan: VerticalFlightPlan,
    maxFpa: number
  ): boolean {

    if (currentConstraint.targetAltitude < Number.POSITIVE_INFINITY && previousConstrant.targetAltitude >= 0) {
      const constraintDistance = VNavUtils.getConstraintDistanceFromLegs(currentConstraint, previousConstrant, verticalPlan);
      const minFpaTempValue = VNavUtils.getFpa(constraintDistance, Math.abs(currentConstraint.targetAltitude - previousConstrant.targetAltitude));

      if (minFpaTempValue > maxFpa) {
        return true;
      }
    }
    return false;
  }

  /**
   * Creates a new empty constraint.
   * @param index The leg index of the constraint.
   * @param targetAltitude The altitude of the constraint.
   * @param name The name of the leg for the constraint.
   * @param type The type of constraint.
   * @returns A new empty constraint.
   */
  private createConstraint(index: number, targetAltitude: number, name: string, type: 'descent'): VNavConstraint {
    return {
      index,
      targetAltitude,
      minAltitude: Number.NEGATIVE_INFINITY,
      maxAltitude: Number.POSITIVE_INFINITY,
      name,
      isTarget: false,
      isPathEnd: false,
      distance: 0,
      fpa: 0,
      legs: [],
      type,
      isBeyondFaf: false
    };
  }

  /**
   * Creates a new VNAV plan leg.
   * @param segmentIndex The segment index for the leg.
   * @param legIndex The index of the leg within the segment.
   * @param name The name of the leg.
   * @param distance The leg distance.
   * @returns A new VNAV plan leg.
   */
  private createLeg(segmentIndex: number, legIndex: number, name: string, distance = 0): VNavLeg {
    return {
      segmentIndex,
      legIndex,
      fpa: 0,
      altitude: 0,
      isUserDefined: false,
      isDirectToTarget: false,
      distance: distance,
      isEligible: true,
      isBod: false,
      isAdvisory: true,
      name
    };
  }

  /**
   * Sends an event when a vertical plan has been built or rebuilt.
   * @param planIndex The index of the plan that was built.
   */
  private notifyBuilt(planIndex: number): void {
    (this.planBuilt as SubEvent<this, number>).notify(this, planIndex);
  }

  /**
   * Sends an event when a vertical plan has been calculated.
   * @param planIndex The index of the plan that was calculated.
   */
  private notifyCalculated(planIndex: number): void {
    (this.vnavCalculated as SubEvent<this, number>).notify(this, planIndex);
  }

  /** @inheritdoc */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public requestPathCompute(planIndex: number): boolean {
    return false;
    //not implemented
  }

}