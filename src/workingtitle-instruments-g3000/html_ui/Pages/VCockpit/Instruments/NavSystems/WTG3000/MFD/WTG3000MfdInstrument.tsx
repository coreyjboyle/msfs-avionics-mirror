import {
  APRadioNavInstrument, ArrayUtils, AuralAlertSystem, AuralAlertSystemWarningAdapter, AuralAlertSystemXmlAdapter,
  CasSystem, CasSystemLegacyAdapter, ClockEvents, CompositeLogicXMLHost, ControlEvents, DefaultXmlAuralAlertParser,
  FlightPlanCalculatedEvent, FlightTimerInstrument, FlightTimerMode, FSComponent, GameStateProvider, GpsSynchronizer,
  GPSSystemState, LNavComputer, LNavObsManager, MinimumsManager, NavComInstrument, NavSourceType, PluginSystem,
  SetSubject, SimVarValueType, SoundServer, Subject, TrafficInstrument, UserSetting, Value, Vec2Math, VNavControlEvents,
  VNode, Wait, XMLWarningFactory, XPDRInstrument
} from '@microsoft/msfs-sdk';

import {
  AdcSystemSelector, ComRadioSpacingManager, DateTimeUserSettings, DefaultGpsIntegrityDataProvider, DefaultRadarAltimeterDataProvider,
  DefaultTerrainSystemDataProvider, DefaultVNavDataProvider, DefaultWindDataProvider, DmeUserSettings, FlightPathCalculatorManager, FlightPlanSimSyncManager,
  Fms, FmsPositionMode, FmsPositionSystemSelector, GarminAPConfig, GarminAPStateManager, GarminAPUtils, GarminGoAroundManager, GarminHeadingSyncManager,
  GarminNavToNavComputer, GarminObsLNavModule, GarminTimerControlEvents, GarminTimerManager, GarminXpdrTcasManager, MapTerrainWxSettingCompatManager, MinimumsUnitsManager,
  NavdataComputer, TrafficOperatingModeManager, TrafficOperatingModeSetting, TrafficSystemType, TrafficUserSettings, UnitsUserSettings
} from '@microsoft/msfs-garminsdk';

import {
  AuralAlertUserSettings, AuralAlertVoiceSetting, AvionicsConfig, AvionicsStatus, AvionicsStatusChangeEvent, AvionicsStatusEvents, AvionicsStatusGlobalPowerEvent,
  AvionicsStatusManager, ConnextWeatherPaneView, DisplayPaneContainer, DisplayPaneIndex, DisplayPanesController, DisplayPaneViewFactory, DisplayPaneViewKeys,
  FlightPlanListManager, FlightPlanStore, FuelTotalizer, G3000Autopilot, G3000ComRadioUserSettings, G3000FilePaths, G3000UserSettingSaveManager,
  GpsStatusDataProvider, GpsStatusPane, InstrumentBackplaneNames, MapUserSettings, MfdNavDataBarUserSettings, NavigationMapPaneView,
  NavRadioMonitorUserSettings, NearestPaneView, PfdUserSettings, ProcedurePreviewPaneView, ToldModule, TouchdownCalloutUserSettings,
  TrafficMapPaneView, WaypointInfoPaneView, WeatherRadarPaneView, WTG3000BaseInstrument, WTG3000FsInstrument
} from '@microsoft/msfs-wtg3000-common';

import { CasMasterAuralAlertManager } from './CAS/CasMasterAuralAlertManager';
import { MfdNavDataBar } from './Components/NavDataBar/MfdNavDataBar';
import { StartupScreen } from './Components/Startup/StartupScreen';
import { StartupScreenPrebuiltRow, StartupScreenRowFactory } from './Components/Startup/StartupScreenRow';
import { MfdConfig } from './Config/MfdConfig';
import { FmsSpeedManager } from './FmsSpeed/FmsSpeedManager';
import { G3000MfdPlugin, G3000MfdPluginBinder } from './G3000MFDPlugin';
import { AltimeterBaroKeyEventHandler } from './Input/AltimeterBaroKeyEventHandler';
import { ActiveNavSourceManager } from './Navigation/ActiveNavSourceManager';
import { FmsVSpeedManager } from './Performance/TOLD/FmsVSpeedManager';
import { ToldComputer } from './Performance/TOLD/ToldComputer';
import { WeightFuelComputer } from './Performance/WeightFuel/WeightFuelComputer';
import { ComRadioTxRxManager } from './Radio/ComRadioTxRxManager';
import { DmeTuneManager } from './Radio/DmeTuneManager';
import { NavRadioMonitorManager } from './Radio/NavRadioMonitorManager';
import { TerrainSystemAuralManager } from './Terrain/TerrainSystemAuralManager';
import { TouchdownCalloutAuralManager } from './Terrain/TouchdownCalloutAuralManager';
import { VSpeedBugManager } from './VSpeed/VSpeedBugManager';
import { WeatherRadarManager } from './WeatherRadar/WeatherRadarManager';

import './WTG3000_MFD.css';

/**
 * A G3000/5000 MFD instrument.
 */
export class WTG3000MfdInstrument extends WTG3000FsInstrument {
  /** The amount of time between periodic active flight plan calculations, in milliseconds. */
  private static readonly ACTIVE_FLIGHT_PLAN_CALC_PERIOD = 3000;

  /** @inheritdoc */
  protected readonly iauIndex = this.instrumentConfig.iauIndex;

  private readonly logicHost = new CompositeLogicXMLHost();

  private readonly soundServer2 = new SoundServer(this.bus);
  private readonly auralAlertSystem = new AuralAlertSystem(this.bus);

  private readonly iauAliasedSettingManager = this.iauSettingManager.getAliasedManager(this.iauIndex);

  private readonly highlightRef = FSComponent.createRef<HTMLElement>();
  private readonly startupScreenRef = FSComponent.createRef<StartupScreen>();
  private readonly displayPaneContainerRef = FSComponent.createRef<DisplayPaneContainer>();

  private readonly bootSplashCssClass = SetSubject.create(['mfd-boot-splash']);

  private readonly avionicsStatusManager = new AvionicsStatusManager(this.bus);

  private readonly obsManager = new LNavObsManager(this.bus, 0, true);

  private readonly navComInstrument = new NavComInstrument(this.bus, undefined, 2, 2);
  private readonly apRadioNavInstrument = new APRadioNavInstrument(this.bus);
  private readonly timerInstrument = new FlightTimerInstrument(this.bus, 2);
  private readonly fuelTotalizerInstrument: FuelTotalizer = new FuelTotalizer(this.bus);

  private readonly fmsPositionSelector = new FmsPositionSystemSelector(this.bus, ArrayUtils.create(this.config.iauDefs.count, index => index + 1), 1);

  private readonly flightPlanStore = new FlightPlanStore(this.bus, this.fms, Fms.PRIMARY_PLAN_INDEX, this.config.vnav.advanced);

  private readonly flightPlanListManagers = {
    [DisplayPaneIndex.LeftMfd]: new FlightPlanListManager(this.bus, this.flightPlanStore, this.fms, Fms.PRIMARY_PLAN_INDEX, Subject.create(false)),
    [DisplayPaneIndex.RightMfd]: new FlightPlanListManager(this.bus, this.flightPlanStore, this.fms, Fms.PRIMARY_PLAN_INDEX, Subject.create(false)),
  } as Record<DisplayPaneIndex, FlightPlanListManager>;

  private readonly casSystem = new CasSystem(this.bus, true);
  private readonly casLegacyAdapter = new CasSystemLegacyAdapter(this.bus, this.logicHost, this.config.annunciations);
  private readonly casMasterAuralAlertManager = new CasMasterAuralAlertManager(this.bus);

  private readonly auralAlertXmlAdapter = new AuralAlertSystemXmlAdapter(
    this.bus,
    this.logicHost,
    this.casSystem,
    this.instrument.xmlConfig.getElementsByTagName('PlaneHTMLConfig')[0].querySelector(':scope>AuralAlerts'),
    new DefaultXmlAuralAlertParser(this.instrument, 'g3000-aural-$$xml-default$$')
  );
  private readonly auralAlertWarningAdapter = new AuralAlertSystemWarningAdapter(
    this.bus,
    this.logicHost,
    new XMLWarningFactory(this.instrument).parseConfig(this.instrument.xmlConfig),
    'g3000-aural-$$warning-default$$'
  );

  private readonly flightPathCalcManager = new FlightPathCalculatorManager(
    this.bus,
    {
      isAdcDataValid: Subject.create(true),
      isGpsDataValid: Subject.create(true),
      maxBankAngle: this.config.fms.flightPathOptions.maxBankAngle,
      lowBankAngle: this.config.fms.flightPathOptions.lowBankAngle
    }
  );

  private readonly comRadioSpacingManager = new ComRadioSpacingManager(this.bus, G3000ComRadioUserSettings.getManager(this.bus));
  private readonly comRadioTxRxManager = new ComRadioTxRxManager(this.bus);

  private readonly activeNavSourceManager = new ActiveNavSourceManager(this.bus);
  private readonly navRadioMonitorManager = new NavRadioMonitorManager(this.bus, NavRadioMonitorUserSettings.getManager(this.bus));
  private readonly dmeTuneManager = new DmeTuneManager(this.bus, DmeUserSettings.getManager(this.bus), this.config.radios.dmeCount);

  // TODO: Figure out how many generic timers the G3000 can actually support (i.e. whether the pilot/copilot each gets their own timer)
  private readonly timerManager = new GarminTimerManager(this.bus, 1);

  private readonly gpsSynchronizer = new GpsSynchronizer(this.bus, this.flightPlanner, this.facLoader);
  private readonly lnavMaxBankAngle = (): number => {
    return this.autopilot.apValues.maxBankId.get() === 1
      ? Math.min(this.config.autopilot.lnavOptions.maxBankAngle, this.config.autopilot.lowBankOptions.maxBankAngle)
      : this.config.autopilot.lnavOptions.maxBankAngle;
  };
  private readonly lnavComputer = new LNavComputer(
    0,
    this.bus,
    this.flightPlanner,
    new GarminObsLNavModule(0, this.bus, this.flightPlanner, {
      maxBankAngle: this.lnavMaxBankAngle,
      intercept: GarminAPUtils.lnavIntercept,
    }),
    {
      maxBankAngle: this.lnavMaxBankAngle,
      intercept: GarminAPUtils.lnavIntercept,
      isPositionDataValid: () => this.fmsPositionSelector.selectedFmsPosMode.get() !== FmsPositionMode.None,
      hasVectorAnticipation: true
    }
  );
  private readonly navdataComputer = new NavdataComputer(this.bus, this.flightPlanner, this.facLoader, { lnavIndex: 0 });

  private readonly radarAltimeterDataProvider = new DefaultRadarAltimeterDataProvider(this.bus);

  private readonly gps1DataProvider = new GpsStatusDataProvider(this.bus, 1);
  private readonly gps2DataProvider = new GpsStatusDataProvider(this.bus, 2);

  private readonly navToNavComputer = new GarminNavToNavComputer(this.bus, this.fms, {
    navRadioIndexes: [1, 2]
  });

  private readonly apConfig = new GarminAPConfig(this.bus, this.fms, this.verticalPathCalculator, {
    useIndicatedMach: true,
    lnavOptions: {
      steerCommand: this.lnavComputer.steerCommand
    },
    vnavOptions: {
      allowApproachBaroVNav: true,
      allowPlusVWithoutSbas: true,
      allowRnpAr: this.config.fms.approach.supportRnpAr,
      enableAdvancedVNav: this.config.vnav.advanced,
      gpsSystemState: Subject.create(GPSSystemState.DiffSolutionAcquired)
    },
    navToNavGuidance: {
      cdiId: Value.create(''),
      armableNavRadioIndex: this.navToNavComputer.armableNavRadioIndex,
      armableLateralMode: this.navToNavComputer.armableLateralMode,
      armableVerticalMode: this.navToNavComputer.armableVerticalMode,
      canSwitchCdi: this.navToNavComputer.canSwitchCdi,
      isExternalCdiSwitchInProgress: Value.create(false)
    },
    rollMinBankAngle: this.config.autopilot.rollOptions.minBankAngle,
    rollMaxBankAngle: this.config.autopilot.rollOptions.maxBankAngle,
    hdgMaxBankAngle: this.config.autopilot.hdgOptions.maxBankAngle,
    vorMaxBankAngle: this.config.autopilot.vorOptions.maxBankAngle,
    locMaxBankAngle: this.config.autopilot.locOptions.maxBankAngle,
    lnavMaxBankAngle: this.config.autopilot.lnavOptions.maxBankAngle,
    lowBankAngle: this.config.autopilot.lowBankOptions.maxBankAngle,
  });

  private readonly autopilot = new G3000Autopilot(
    this.bus, this.flightPlanner,
    this.apConfig,
    new GarminAPStateManager(this.bus, this.apConfig),
    PfdUserSettings.getMasterManager(this.bus),
    this.minimumsDataProvider
  );
  private readonly goAroundManager = new GarminGoAroundManager(this.bus, this.fms);
  private readonly headingSyncManager = new GarminHeadingSyncManager(this.bus, 1, {
    supportTurnHeadingAdjust: true,
    supportHeadingSyncMode: this.config.autopilot.isHdgSyncModeSupported
  });

  private readonly fmsSpeedManager = this.config.vnav.fmsSpeeds !== undefined && this.fmsSpeedsSettingManager !== undefined
    ? new FmsSpeedManager(this.bus, this.facLoader, this.flightPlanner, this.speedConstraintStore, this.config.vnav.fmsSpeeds, this.fmsSpeedsSettingManager, 1, 1)
    : undefined;

  private readonly windDataProvider = new DefaultWindDataProvider(
    this.bus,
    this.iauAliasedSettingManager.getSetting('iauAdcIndex'),
    this.iauAliasedSettingManager.getSetting('iauAhrsIndex'),
    this.instrument.instrumentIndex
  );

  private readonly vnavDataProvider = new DefaultVNavDataProvider(
    this.bus,
    this.fms,
    this.iauAliasedSettingManager.getSetting('iauAdcIndex')
  );

  private readonly minimumsManager = new MinimumsManager(this.bus);
  private readonly minimumsUnitsManager = new MinimumsUnitsManager(this.bus);

  private readonly trafficInstrument = new TrafficInstrument(this.bus, { realTimeUpdateFreq: 2, simTimeUpdateFreq: 1, contactDeprecateTime: 10 });
  private readonly xpdrInstrument = new XPDRInstrument(this.bus);
  private readonly trafficAvionicsSystem = this.config.traffic.resolve()(this.bus, this.trafficInstrument, 10000);
  private readonly trafficSystem = this.trafficAvionicsSystem.trafficSystem;
  private readonly trafficOperatingModeManager = this.trafficSystem.type === TrafficSystemType.Tas || this.trafficSystem.type === TrafficSystemType.Tis
    ? new TrafficOperatingModeManager(this.bus)
    : undefined;

  private readonly terrainSystemAdcSelector = new AdcSystemSelector(
    this.bus,
    ArrayUtils.range(this.config.sensors.adcCount, 1),
    {
      systemPriorities: ArrayUtils.range(this.config.sensors.adcCount, 1),
      desirabilityComparator: (a, b) => {
        const [aAltitudeDataValid, aAirspeedDataValid, aTemperatureDataValid] = a;
        const [bAltitudeDataValid, bAirspeedDataValid, bTemperatureDataValid] = b;

        if (aAltitudeDataValid && !bAltitudeDataValid) {
          return -1;
        } else if (!aAltitudeDataValid && bAltitudeDataValid) {
          return 1;
        } else {
          return (bAirspeedDataValid && bTemperatureDataValid ? 1 : 0)
            - (aAirspeedDataValid && aTemperatureDataValid ? 1 : 0);
        }
      }
    }
  );
  private readonly terrainSystemAhrsSelector = new AdcSystemSelector(
    this.bus,
    ArrayUtils.range(this.config.sensors.ahrsCount, 1),
    {
      systemPriorities: ArrayUtils.range(this.config.sensors.ahrsCount, 1)
    }
  );
  private readonly terrainSystemDataProvider = new DefaultTerrainSystemDataProvider(this.bus, this.fms, {
    fmsPosIndex: this.fmsPositionSelector.selectedIndex,
    radarAltIndex: this.config.sensors.hasRadarAltimeter ? 1 : -1,
    adcIndex: this.terrainSystemAdcSelector.selectedIndex,
    ahrsIndex: this.terrainSystemAhrsSelector.selectedIndex
  });
  private readonly terrainSystem = this.config.terrain.resolve()(this.bus, this.fms, this.terrainSystemDataProvider);
  private readonly terrainSystemAuralManager = new TerrainSystemAuralManager(this.bus, this.terrainSystemStateDataProvider);
  private readonly touchdownCalloutAuralManager = new TouchdownCalloutAuralManager(this.bus);

  private readonly xpdrTcasManager?: GarminXpdrTcasManager;

  private readonly weatherRadarManager?: WeatherRadarManager;

  private readonly displayPanesController = new DisplayPanesController(this.bus);
  private readonly displayPaneViewFactory = new DisplayPaneViewFactory();

  private readonly gpsIntegrityDataProvider = new DefaultGpsIntegrityDataProvider(this.bus, this.iauIndex);

  private readonly vSpeedBugManager = new VSpeedBugManager(this.bus, this.vSpeedSettingManager, this.config.sensors.adcCount);

  private readonly weightFuelComputer = new WeightFuelComputer(this.bus, this.fms, this.iauIndex);

  private readonly fmsVSpeedManager = this.config.performance.isToldSupported
    ? new FmsVSpeedManager(this.vSpeedSettingManager)
    : undefined;

  private readonly toldComputer = this.config.performance.toldConfig !== undefined
    ? new ToldComputer(
      this.bus,
      this.facLoader,
      this.fms,
      this.config.sensors.adcCount,
      this.config.performance.toldConfig,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.fmsVSpeedManager!,
      this.vSpeedSettingManager
    )
    : undefined;
  private toldModule?: ToldModule;

  private readonly mapTerrainWxCompatManagers = [
    new MapTerrainWxSettingCompatManager(MapUserSettings.getPfdManager(this.bus, 1)),
    new MapTerrainWxSettingCompatManager(MapUserSettings.getDisplayPaneManager(this.bus, DisplayPaneIndex.LeftPfd)),
    new MapTerrainWxSettingCompatManager(MapUserSettings.getDisplayPaneManager(this.bus, DisplayPaneIndex.LeftMfd)),
    new MapTerrainWxSettingCompatManager(MapUserSettings.getDisplayPaneManager(this.bus, DisplayPaneIndex.RightMfd)),
    new MapTerrainWxSettingCompatManager(MapUserSettings.getDisplayPaneManager(this.bus, DisplayPaneIndex.RightPfd)),
    new MapTerrainWxSettingCompatManager(MapUserSettings.getPfdManager(this.bus, 2))
  ];

  private readonly altimeterBaroKeyEventHandler = new AltimeterBaroKeyEventHandler(
    this.bus,
    this.config.iauDefs.definitions.slice(1).map(def => {
      return {
        index: def.altimeterIndex,
        supportBaroPreselect: def.supportBaroPreselect
      };
    })
  );

  private settingSaveManager?: G3000UserSettingSaveManager;

  private flightPlanSimSyncManager?: FlightPlanSimSyncManager;
  private isPrimaryFlightPlanInit = false;

  private lastActiveFplCalcTime = 0;

  private avionicsGlobalPowerState: boolean | undefined = undefined;

  private readonly pluginSystem = new PluginSystem<G3000MfdPlugin, G3000MfdPluginBinder>();

  /**
   * Constructor.
   * @param instrument This instrument's parent BaseInstrument.
   * @param config This instrument's general configuration object.
   * @param instrumentConfig This instrument's instrument-specific configuration object.
   */
  constructor(instrument: BaseInstrument, config: AvionicsConfig, private readonly instrumentConfig: MfdConfig) {
    super('MFD', instrument, config);

    //Sets the simvar that tells the VFRMap not to construct a flight plan for display from the game
    //flight plan, but instead to get flight plan events from the avionics.
    SimVar.SetSimVarValue('L:XMLVAR_NEXTGEN_FLIGHTPLAN_ENABLED', SimVarValueType.Bool, true);

    this.flightPlanStore.init();

    this.createSystems();

    this.backplane.addInstrument(InstrumentBackplaneNames.NavCom, this.navComInstrument);
    this.backplane.addInstrument(InstrumentBackplaneNames.AutopilotRadioNav, this.apRadioNavInstrument);
    this.backplane.addInstrument(InstrumentBackplaneNames.Traffic, this.trafficInstrument);
    this.backplane.addInstrument(InstrumentBackplaneNames.Xpdr, this.xpdrInstrument);
    this.backplane.addInstrument(InstrumentBackplaneNames.Timer, this.timerInstrument);
    this.backplane.addInstrument(InstrumentBackplaneNames.FuelTotalizer, this.fuelTotalizerInstrument);

    this.obsManager.init();

    if (this.trafficSystem.type === TrafficSystemType.TcasII) {
      this.xpdrTcasManager = new GarminXpdrTcasManager(this.bus, 1);
    }

    if (this.config.sensors.weatherRadarDefinition !== undefined) {
      this.weatherRadarManager = new WeatherRadarManager(
        this.bus,
        this.config.sensors.weatherRadarDefinition.scanActiveCircuitIndex,
        this.config.sensors.weatherRadarDefinition.scanActiveCircuitProcedureIndex
      );
    }

    this.initAuralAlertUserSettings();
    this.initTouchdownCalloutUserSettings();

    this.doInit().catch(e => {
      console.error(e);
    });
  }

  /** @inheritdoc */
  protected createSystems(): void {
    super.createSystems();

    this.systems.push(this.trafficAvionicsSystem);
  }

  /**
   * Initializes aural alert user settings.
   */
  private initAuralAlertUserSettings(): void {
    // Check if only one aural alert voice is supported. If so, force the setting to that value.
    if (this.config.auralAlerts.supportedVoices !== 'both') {
      const voice = this.config.auralAlerts.supportedVoices === 'male' ? AuralAlertVoiceSetting.Male : AuralAlertVoiceSetting.Female;
      AuralAlertUserSettings.getManager(this.bus).getSetting('auralAlertVoice').value = voice;
    }
  }

  /**
   * Initializes touchdown callout user settings.
   */
  private initTouchdownCalloutUserSettings(): void {
    if (!this.config.terrain.touchdownCallouts) {
      return;
    }

    const settingManager = TouchdownCalloutUserSettings.getManager(this.bus);
    for (const options of Object.values(this.config.terrain.touchdownCallouts.options)) {
      settingManager.getEnabledSetting(options.altitude).value = options.enabled;
    }
  }

  /**
   * Performs initialization tasks.
   */
  private async doInit(): Promise<void> {
    await this.pluginSystem.addScripts(this.instrument.xmlConfig, this.instrument.templateID, (target) => {
      return target === this.instrument.templateID;
    });
    const pluginBinder: G3000MfdPluginBinder = {
      bus: this.bus,
      backplane: this.backplane,
      config: this.config,
      instrumentConfig: this.instrumentConfig,
      facLoader: this.facLoader,
      flightPathCalculator: this.flightPathCalculator,
      fms: this.fms,
      iauSettingManager: this.iauSettingManager,
      vSpeedSettingManager: this.vSpeedSettingManager,
      fmsSpeedsSettingManager: this.fmsSpeedsSettingManager,
      flightPlanStore: this.flightPlanStore,
      casSystem: this.casSystem
    };

    await this.pluginSystem.startSystem(pluginBinder);

    const pluginPersistentSettings = new Map<string, UserSetting<any>>();

    this.pluginSystem.callPlugins((plugin: G3000MfdPlugin) => {
      for (const setting of plugin.getPersistentSettings()) {
        pluginPersistentSettings.set(setting.definition.name, setting);
      }
    });

    this.initPersistentSettings(pluginPersistentSettings.values());

    this.auralAlertXmlAdapter.start();
    this.auralAlertWarningAdapter.start();

    this.pluginSystem.callPlugins((plugin: G3000MfdPlugin) => {
      plugin.onInit();
      if (this.config.performance.isToldSupported) {
        this.toldModule ??= plugin.getToldModule();
      }
    });

    this.backplane.init();

    this.avionicsStatusManager.init();

    this.flightPathCalcManager.init();

    this.initActiveFplCalcListener();
    this.initPrimaryFlightPlan();

    this.fmsPositionSelector.init();

    this.radarAltimeterDataProvider.init();
    this.gps1DataProvider.init();
    this.gps2DataProvider.init();
    this.minimumsDataProvider.init();
    this.terrainSystemStateDataProvider.init();
    this.activeNavSourceManager.init();
    this.dmeTuneManager.init();
    this.comRadioTxRxManager.init();
    this.timerManager.init();
    this.goAroundManager.init();
    this.headingSyncManager.init();
    this.fmsSpeedManager?.init();
    this.minimumsUnitsManager.init();
    this.xpdrTcasManager?.init(true);
    this.trafficSystem.init();

    if (this.terrainSystem) {
      this.terrainSystemAdcSelector.init();
      this.terrainSystemAhrsSelector.init();
      this.terrainSystemDataProvider.init();
      this.terrainSystem.init();

      this.terrainSystemAuralManager.init();
      this.touchdownCalloutAuralManager.init();
    }

    this.weatherRadarManager?.init();
    this.gpsIntegrityDataProvider.init();
    this.vSpeedBugManager.init(true);
    this.windDataProvider.init();
    this.vnavDataProvider.init();
    this.weightFuelComputer.init();

    if (this.toldComputer !== undefined && this.toldModule !== undefined) {
      this.toldComputer.init(this.toldModule, true);
    }

    this.mapTerrainWxCompatManagers.forEach(manager => { manager.init(); });

    this.casPowerStateManager.init();
    this.casMasterAuralAlertManager.init();

    this.altimeterBaroKeyEventHandler.init();

    this.bus.getSubscriber<AvionicsStatusEvents>().on('avionics_global_power').handle(this.onGlobalPowerChanged.bind(this));

    this.registerDisplayPaneViews();
    this.pluginSystem.callPlugins((plugin: G3000MfdPlugin) => {
      plugin.registerDisplayPaneViews(this.displayPaneViewFactory);
    });

    FSComponent.render(
      this.renderComponents(),
      this.instrument.getChildById('Electricity')
    );

    (this.instrument as WTG3000BaseInstrument<this>).setHighlightElement(this.highlightRef.instance);

    this.initAvionicsStatusListener();

    Wait.awaitSubscribable(GameStateProvider.get(), state => state === GameState.briefing || state === GameState.ingame, true).then(() => {
      this.bus.getSubscriber<ClockEvents>().on('simTimeHiFreq').handle(() => {
        this.lnavComputer.update();
        this.autopilot.update();
      });
    });

    this.doDelayedInit();
  }

  /**
   * Performs initialization tasks after a 500-millisecond wait.
   */
  private async doDelayedInit(): Promise<void> {
    await Wait.awaitDelay(500);

    this.casLegacyAdapter.start();
    this.comRadioSpacingManager.init();
    this.navRadioMonitorManager.init();

    // We need to delay initialization of this manager because the on ground simvar is not properly initialized for in-air starts.
    this.trafficOperatingModeManager?.init(this.avionicsGlobalPowerState !== true);

    if (this.trafficSystem.type === TrafficSystemType.TcasII) {
      TrafficUserSettings.getManager(this.bus).getSetting('trafficOperatingMode').value = TrafficOperatingModeSetting.Auto;
    }
  }

  /**
   * Initializes persistent settings. Loads saved settings and starts auto-save.
   * @param pluginSettings Persistent settings defined by plugins.
   */
  private initPersistentSettings(pluginSettings: Iterable<UserSetting<any>>): void {
    this.settingSaveManager = new G3000UserSettingSaveManager(
      this.bus,
      this.config,
      pluginSettings,
      this.fmsSpeedsSettingManager
    );
    const profileKey = `${SimVar.GetSimVarValue('ATC MODEL', 'string')}_g3000-default-profile`;
    this.settingSaveManager.load(profileKey);
    this.settingSaveManager.startAutoSave(profileKey);
  }

  /**
   * Initializes the primary flight plan.
   */
  private async initPrimaryFlightPlan(): Promise<void> {
    // TODO Am I doing this right? There's more than 1 other instrument, maybe we should make sure only 1 responds?
    // Request a sync from any other instrument in case of an instrument reload
    this.fms.flightPlanner.requestSync();
    await Wait.awaitDelay(500);
    // Initialize the primary plan in case one was not synced.
    await this.fms.initPrimaryFlightPlan();

    // Wait for the game to finish loading.
    await Wait.awaitSubscribable(GameStateProvider.get(), state => state === GameState.briefing || state === GameState.ingame, true);

    this.flightPlanSimSyncManager = await FlightPlanSimSyncManager.getManager(this.bus, this.fms);

    // Wait 5 seconds because trying to load the sim flight plan too early sometimes ends up with missing waypoints.
    await Wait.awaitDelay(5000);

    try {
      await this.flightPlanSimSyncManager.loadFromSim();
    } catch (e) {
      console.error(e);
      if (e instanceof Error) {
        console.error(e.stack);
      }
    }

    this.flightPlanSimSyncManager.startAutoSync();

    this.isPrimaryFlightPlanInit = true;
  }

  /**
   * Registers display pane views with this instrument's display pane view factory.
   */
  private registerDisplayPaneViews(): void {
    this.displayPaneViewFactory.registerView(DisplayPaneViewKeys.NavigationMap, index => {
      return (
        <NavigationMapPaneView
          index={index} bus={this.bus}
          facLoader={this.facLoader}
          flightPlanner={this.flightPlanner}
          trafficSystem={this.trafficSystem}
          flightPlanStore={this.flightPlanStore}
          windDataProvider={this.windDataProvider}
          vnavDataProvider={this.vnavDataProvider}
          fms={this.fms}
          flightPlanListManager={this.flightPlanListManagers[index]}
          iauSettingManager={this.iauSettingManager}
          config={this.config.map}
        />
      );
    });
    this.displayPaneViewFactory.registerView(DisplayPaneViewKeys.TrafficMap, index => {
      return (
        <TrafficMapPaneView
          index={index}
          bus={this.bus}
          flightPlanner={this.flightPlanner}
          trafficSystem={this.trafficSystem}
          iauSettingManager={this.iauSettingManager}
          config={this.config.map}
        />
      );
    });
    this.displayPaneViewFactory.registerView(DisplayPaneViewKeys.WeatherMap, index => {
      return (
        <ConnextWeatherPaneView
          index={index}
          bus={this.bus}
          flightPlanner={this.flightPlanner}
          windDataProvider={this.windDataProvider}
          iauSettingManager={this.iauSettingManager}
          config={this.config.map}
        />
      );
    });
    this.displayPaneViewFactory.registerView(DisplayPaneViewKeys.ProcedurePreview, index => {
      return (
        <ProcedurePreviewPaneView
          index={index}
          bus={this.bus}
          fms={this.fms}
          flightPathCalculator={this.flightPathCalculator}
          iauSettingManager={this.iauSettingManager}
          config={this.config.map}
        />
      );
    });
    this.displayPaneViewFactory.registerView(DisplayPaneViewKeys.WaypointInfo, index => {
      return <WaypointInfoPaneView index={index} bus={this.bus} facLoader={this.facLoader} iauSettingManager={this.iauSettingManager} config={this.config.map} />;
    });
    this.displayPaneViewFactory.registerView(DisplayPaneViewKeys.Nearest, index => {
      return (
        <NearestPaneView
          index={index}
          bus={this.bus}
          facLoader={this.facLoader}
          flightPlanner={this.flightPlanner}
          trafficSystem={this.trafficSystem}
          windDataProvider={this.windDataProvider}
          iauSettingManager={this.iauSettingManager}
          config={this.config.map}
        />
      );
    });

    if (this.config.sensors.hasWeatherRadar) {
      this.displayPaneViewFactory.registerView(DisplayPaneViewKeys.WeatherRadar, index => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return <WeatherRadarPaneView index={index} bus={this.bus} config={this.config.sensors.weatherRadarDefinition!} />;
      });
    }

    this.displayPaneViewFactory
      .registerView(DisplayPaneViewKeys.Gps1Status, index => <GpsStatusPane dataProvider={this.gps1DataProvider} bus={this.bus} index={index} halfSizeOnly />);
    this.displayPaneViewFactory
      .registerView(DisplayPaneViewKeys.Gps2Status, index => <GpsStatusPane dataProvider={this.gps2DataProvider} bus={this.bus} index={index} halfSizeOnly />);
  }

  /**
   * Initializes a listener which records the most recent time the active flight plan was calculated.
   */
  private initActiveFplCalcListener(): void {
    this.flightPlanner.onEvent('fplCalculated').handle((e: FlightPlanCalculatedEvent) => {
      if (e.planIndex === this.flightPlanner.activePlanIndex) {
        this.lastActiveFplCalcTime = Date.now();
      }
    });
  }

  /**
   * Renders this instrument's components.
   * @returns This instrument's rendered components, as a VNode.
   */
  private renderComponents(): VNode {
    let renderedEis: VNode | null = null;
    this.pluginSystem.callPlugins((plugin: G3000MfdPlugin) => {
      renderedEis ??= plugin.renderEis();
    });

    let startupScreenRows: readonly (StartupScreenRowFactory | StartupScreenPrebuiltRow)[] | undefined = undefined;
    if (this.instrumentConfig.startupScreen) {
      this.pluginSystem.callPlugins((plugin: G3000MfdPlugin) => {
        startupScreenRows ??= plugin.getStartupScreenRows();
      });
    }

    return (
      <>
        <MfdNavDataBar
          bus={this.bus}
          fms={this.fms}
          gpsIntegrityDataProvider={this.gpsIntegrityDataProvider}
          dataBarSettingManager={MfdNavDataBarUserSettings.getManager(this.bus)}
          unitsSettingManager={UnitsUserSettings.getManager(this.bus)}
          dateTimeSettingManager={DateTimeUserSettings.getManager(this.bus)}
          updateFreq={1}
        />
        <DisplayPaneContainer
          ref={this.displayPaneContainerRef}
          bus={this.bus}
          leftIndex={DisplayPaneIndex.LeftMfd}
          rightIndex={DisplayPaneIndex.RightMfd}
          leftPaneFullSize={Vec2Math.create(995, 748)}
          leftPaneHalfSize={Vec2Math.create(495, 748)}
          rightPaneFullSize={Vec2Math.create(995, 748)}
          rightPaneHalfSize={Vec2Math.create(495, 748)}
          displayPaneViewFactory={this.displayPaneViewFactory}
          updateFreq={30}
          alternateUpdatesInSplitMode
          class='display-pane-container-mfd'
        />
        <div class="engine-instruments">
          {renderedEis}
        </div>
        <glasscockpit-highlight ref={this.highlightRef} id="highlight"></glasscockpit-highlight>
        {this.instrumentConfig.startupScreen && (
          <StartupScreen
            ref={this.startupScreenRef}
            airplaneName={this.instrumentConfig.startupScreen.airplaneName}
            airplaneLogoFilePath={this.instrumentConfig.startupScreen.airplaneLogoFilePath}
            bus={this.bus}
            rows={startupScreenRows}
            confirmationSoftkeyEvent='AS3000_MFD_SOFTKEYS_12'
            onConfirmation={this.onStartupConfirmation.bind(this)}
          />
        )}
        <div class={this.bootSplashCssClass}>
          <img src={`${G3000FilePaths.ASSETS_PATH}/Images/Common/garmin_logo.png`} />
        </div>
      </>
    );
  }

  /** @inheritdoc */
  protected getBootDuration(): number {
    return 4500 + Math.random() * 1000;
  }

  /** @inheritdoc */
  public onFlightStart(): void {
    super.onFlightStart();

    this.autopilot.stateManager.initialize();
  }

  /** @inheritdoc */
  public Update(): void {
    super.Update();

    const realTime = Date.now();

    this.gpsSynchronizer.update();
    this.logicHost.update(this.instrument.deltaTime);

    if (this.flightPlanner.hasActiveFlightPlan() && realTime - this.lastActiveFplCalcTime >= WTG3000MfdInstrument.ACTIVE_FLIGHT_PLAN_CALC_PERIOD) {
      this.flightPlanner.getActiveFlightPlan().calculate();
    }

    if (this.terrainSystem) {
      this.terrainSystemDataProvider.update(realTime);
      this.terrainSystem.update();
    }
  }

  /** @inheritdoc */
  public onSoundEnd(soundEventId: Name_Z): void {
    this.soundServer2.onSoundEnd(soundEventId);
  }

  /** @inheritdoc */
  protected onBootFinished(): void {
    if (this.instrumentConfig.startupScreen) {
      this.avionicsStatusClient.setStatus(AvionicsStatus.Startup);
    } else {
      this.avionicsStatusClient.setStatus(AvionicsStatus.On);
    }
  }

  /** @inheritdoc */
  protected onAvionicsStatusChanged(event: Readonly<AvionicsStatusChangeEvent>): void {
    super.onAvionicsStatusChanged(event);

    this.bootSplashCssClass.toggle('hidden', event.current !== AvionicsStatus.Off && event.current !== AvionicsStatus.Booting);

    switch (event.current) {
      case AvionicsStatus.Off:
      case AvionicsStatus.Booting:
        this.startupScreenRef.getOrDefault()?.sleep();
        this.displayPaneContainerRef.instance.sleep();
        break;
      case AvionicsStatus.Startup:
        this.displayPaneContainerRef.instance.sleep();
        this.startupScreenRef.instance.wake();
        break;
      case AvionicsStatus.On:
        this.startupScreenRef.getOrDefault()?.sleep();
        this.displayPaneContainerRef.instance.wake();
        break;
    }
  }

  /**
   * Responds to changes in the avionics global power state.
   * @param event The event describing the change in the avionics global power state.
   */
  private onGlobalPowerChanged(event: Readonly<AvionicsStatusGlobalPowerEvent>): void {
    this.avionicsGlobalPowerState = event.current;

    if (event.previous === true && event.current === false) {
      // Avionics global power off.

      this.headingSyncManager.pause();
      this.headingSyncManager.reset();

      if (this.isPrimaryFlightPlanInit) {
        this.fms.resetAllFlightPlans();
      }

      this.fmsSpeedManager?.resetUserOverride();

      this.vSpeedBugManager.pause();
      this.trafficOperatingModeManager?.pause();
      this.xpdrTcasManager?.pause();
      this.terrainSystem?.turnOff();
      this.terrainSystem?.removeAllInhibits();
      this.toldComputer?.pause();

      // Stop and reset generic timer.
      this.bus.getPublisher<GarminTimerControlEvents>().pub('garmin_gen_timer_set_value_1', 0, true, false);

      this.auralAlertSystem.sleep();

    } else if (event.current === true) {
      // Avionics global power on.

      this.auralAlertSystem.wake();

      this.terrainSystem?.turnOn();

      if (event.previous === false) {
        // Only reset the autopilot if this was a true power cycle. Otherwise we will end up turning the AP off
        // when loading into a flight in-air.
        this.autopilot.reset();

        // Only reset the active nav source to GPS/FMS if this was a true power cycle. Otherwise we will override
        // the nav source set by the .FLT file when loading into a powered-on flight. This will still override the
        // .FLT file on a cold-and-dark start, but there shouldn't ever be a case where a non-default state is desired
        // when loading cold-and-dark.
        this.bus.getPublisher<ControlEvents>().pub('cdi_src_set', { type: NavSourceType.Gps, index: 1 }, true, true);

        this.terrainSystem?.startTest();
      }

      // Reset VNAV to enabled.
      this.bus.getPublisher<VNavControlEvents>().pub('vnav_set_state', true, true, false);

      this.headingSyncManager.resume();

      const pfdSettingManager = PfdUserSettings.getMasterManager(this.bus);
      pfdSettingManager.getSetting('pfdBearingPointer1Source_1').resetToDefault();
      pfdSettingManager.getSetting('pfdBearingPointer1Source_2').resetToDefault();
      pfdSettingManager.getSetting('pfdBearingPointer2Source_1').resetToDefault();
      pfdSettingManager.getSetting('pfdBearingPointer2Source_2').resetToDefault();

      this.navRadioMonitorManager.reset();
      this.comRadioTxRxManager.reset();
      this.vSpeedBugManager.reset();
      this.vSpeedBugManager.resume();
      this.displayPanesController.reset();
      this.trafficOperatingModeManager?.reset();
      this.trafficOperatingModeManager?.resume();
      this.xpdrTcasManager?.reset();
      this.xpdrTcasManager?.resume();
      this.weightFuelComputer.reset();
      this.toldComputer?.reset();
      this.toldComputer?.resume();

      // Set generic timer mode to counting up.
      this.bus.getPublisher<GarminTimerControlEvents>().pub('garmin_gen_timer_set_mode_1', FlightTimerMode.CountingUp, true, false);
    }
  }

  /**
   * Responds to when the user confirms the startup screen.
   */
  private onStartupConfirmation(): void {
    this.avionicsStatusClient.setStatus(AvionicsStatus.On);
  }
}