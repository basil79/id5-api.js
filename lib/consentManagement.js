import {
  cyrb53Hash,
  delve,
  isArray,
  isBoolean,
  isDefined,
  isFn,
  isPlainObject,
  isStr,
  logError,
  logInfo,
  logWarn
} from './utils.js';
import {isPurposeConsentSet} from './tcfUtils.js';
import CONSTANTS from './constants.json';

/* eslint-disable no-unused-vars */
import LocalStorage from './localStorage.js';
/* eslint-enable no-unused-vars */

const ID5_GVL_ID = '131';
const USPAPI_VERSION = 1;
const SURROGATE_CONFIG = {
  tcfv1: {
    objName: '__cmpCall',
    objKeys: ['command', 'parameter'],
    returnObjName: '__cmpReturn'
  },
  tcfv2: {
    objName: '__tcfapiCall',
    objKeys: ['command', 'version'],
    returnObjName: '__tcfapiReturn'
  },
  uspv1: {
    objName: '__uspapiCall',
    objKeys: ['command', 'version'],
    returnObjName: '__uspapiReturn'
  }
};

export const API_TYPE = Object.freeze({
  NONE: 'none',
  TCF_V1: 'TCFv1',
  TCF_V2: 'TCFv2',
  USP_V1: 'USPv1',
  ID5_ALLOWED_VENDORS: 'ID5'
});

/**
 * The GRANT_TYPE tells how the grant to local storage was computed
 * FORCE_ALLOWED_BY_CONFIG - when configuration forces to allow usage of local storage
 * ID5_CONSENT - when either in stored or in received privacy object,
 *               ID5 has consent to use local storage.
 * PROVISIONAL - We don't know yet whether we're granted access by consent.
 *               We allow access but restrictions apply. See isDefinitivelyAllowed().
 * JURISDICTION - The decision was based on the basis of the jurisdiction which
 *                is returned by the ID5 server (or stored from previous calls).
 * CONSENT_API - The decision was based on one of the various consent APIs we interact with.
 */
export const GRANT_TYPE = Object.freeze({
  FORCE_ALLOWED_BY_CONFIG: 'force_allowed_by_config',
  ID5_CONSENT: 'id5_consent',
  PROVISIONAL: 'provisional',
  JURISDICTION: 'jurisdiction',
  CONSENT_API: 'consent_api'
});

export class LocalStorageGrant {
  /**
   * Tells whether or not
   * @type {boolean}
   */
  allowed = false;

  /**
   * The type of grant we got for the current isLocalStorageAllowed() invocation
   * @type {string}
   */
  grantType = GRANT_TYPE.NONE;

  /**
   * The consent API type which is used to determine consent to access local storage
   * @type {string}
   */
  api = API_TYPE.NONE;

  constructor(allowed, grantType, api) {
    this.allowed = allowed;
    this.grantType = grantType;
    this.api = api;
  }

  isDefinitivelyAllowed() {
    return this.allowed && this.grantType !== GRANT_TYPE.PROVISIONAL;
  }
}

export class ConsentData {
  /**
   * The API type which is used to determine consent to access local storage and call the ID5 back-end
   * @type {string}
   */
  api = API_TYPE.NONE;

  /**
   * The GDPR consent string
   * @type {string}
   */
  consentString;

  /** @type {boolean} */
  gdprApplies = false;

  /**
   * @type {boolean|undefined}
   */
  localStoragePurposeConsent;

  /**
   * List of allowed vendors either by IAB GVL ID or by ID5 partner ID
   * @type {Array<string>}
   */
  allowedVendors;

  /** @type {boolean} */
  hasCcpaString = false;

  /** @type {string} */
  ccpaString = '';

  localStorageGrant() {
    return new LocalStorageGrant(this.isGranted(), GRANT_TYPE.CONSENT_API, this.api);
  }

  isGranted() {
    switch (this.api) {
      case API_TYPE.NONE:
        // By default (so no indication from the owner of the page
        // and no consent framework detected on page) we assume that we can use local storage
        return true;
      case API_TYPE.TCF_V1:
        return !this.gdprApplies || this.localStoragePurposeConsent === true;
      case API_TYPE.TCF_V2:
        return this.gdprApplies === false || this.localStoragePurposeConsent === true;
      case API_TYPE.ID5_ALLOWED_VENDORS:
        return this.allowedVendors.includes(ID5_GVL_ID);
      case API_TYPE.USP_V1:
        // CCPA never disallows local storage
        return true;
    }
  }

  /**
   * Note this is not a generic hash code but rather a hash code
   * used to check whether or not consent has changed across invocations
   * @returns a hash code of some properties of this object
   */
  hashCode() {
    /*
    * We hash every properties except:
    *   - localStoragePurposeConsent object since the consentString is enough to know.
    *   - ccpaString as it doesn't contribute to the local storage decision.
    */
    const {localStoragePurposeConsent, ccpaString, ...others} = this;
    return cyrb53Hash(JSON.stringify(others));
  }
}

export class ConsentManagement {
  /** @type {number} */
  invocationId;

  /** @type {ConsentData} */
  consentData;

  /**
   * The ID5 privacy object stored in localStorage
   * @type {Object}
   */
  storedPrivacyData;

  /**
   * The interface to the browser local storage
   * @type {LocalStorage}
   */
  localStorage;

  /**
   * Used to avoid requesting consent too often when not required
   * @type {boolean}
   */
  _consentRequested = false;

  /**
   * @param {LocalStorage} localStorage the localStorage object to use
   * @param {StorageConfig} storageConfig local storage config
   */
  constructor(invocationId, localStorage, storageConfig) {
    this.invocationId = invocationId;
    this.localStorage = localStorage;
    this.storageConfig = storageConfig;
    this.resetConsentData();
  }

  /**
   * Try to fetch consent from CMP. Main entry point to retrieve consent data.
   * @param {boolean} debugBypassConsent
   * @param {string} cmpApi - CMP Api to use
   * @param {object} [providedConsentData] - static consent data provided to ID5 API at init() time
   * @param {function(ConsentData)} finalCallback required; final callback
   */
  requestConsent(debugBypassConsent, cmpApi, providedConsentData, finalCallback) {
    if (debugBypassConsent) {
      this.consentData = new ConsentData();
      logWarn(this.invocationId, 'cmpApi: ID5 is operating in forced consent mode and will not retrieve any consent signals from the CMP');
      finalCallback(this.consentData);
    } else if (!this._consentRequested) {
      this.consentData = new ConsentData();
      this._consentRequested = true;
      switch (cmpApi) {
        case 'static':
          this.parseStaticConsentData(providedConsentData, finalCallback);
          break;
        case 'iab':
          this.lookupIabConsent(finalCallback);
          break;
        default:
          logError(this.invocationId, `cmpApi: Unknown consent API: ${cmpApi}`);
          this.resetConsentData();
          finalCallback(this.consentData);
          break;
      }
    } else {
      finalCallback(this.consentData);
    }
  }

  getOrCreateConsentData() {
    if (!this.consentData) {
      this.consentData = new ConsentData();
    }
    return this.consentData;
  }

  /**
   * This function reads the consent string from the config to obtain the consent
   * information of the user.
   * @param {Object} data the data passed in the static configuration
   * @param {function(ConsentData)} finalCallback required; final callback
   */
  parseStaticConsentData(data, finalCallback) {
    data = data || {};

    // Try to detect the API from the static object structure
    let mergeData = {};
    if (isPlainObject(data.getConsentData)) {
      mergeData = ConsentManagement.parseTcfData(data, 1);
    } else if (isPlainObject(data.getTCData)) {
      mergeData = ConsentManagement.parseTcfData(data.getTCData, 2);
    } else if (isArray(data.allowedVendors)) {
      mergeData = {
        api: API_TYPE.ID5_ALLOWED_VENDORS,
        allowedVendors: data.allowedVendors.map(item => String(item)),
        gdprApplies: true
      };
    } else if (isPlainObject(data.getUSPData)) {
      mergeData = ConsentManagement.parseUspData(data.getUSPData);
    } else {
      logWarn(this.invocationId, 'cmpApi: No static consent data detected! Using defaults.');
    }
    Object.assign(this.consentData, mergeData);
    logInfo(this.invocationId, `cmpApi: Detected API '${this.consentData.api}' from static consent data`, data);
    finalCallback(this.consentData);
  }

  /**
   * This function handles async interacting with an IAB compliant CMP
   * to obtain the consent information of the user.
   * @param {function(ConsentData)} finalCallback required; final callback
   */
  lookupIabConsent(finalCallback) {
    const self = this;
    const done = [];

    // Builds callbacks for the various APIs. It does debouncing and groups
    // the result from all callbacks. It assumes all callbacks are created
    // before any of them fires.
    const makeCallback = (callbackPos) => {
      done[callbackPos] = false;
      return (result) => {
        if (!done[callbackPos]) {
          done[callbackPos] = true;
          if (result) {
            Object.assign(self.consentData, result);
          }
          if (done.every(d => d)) {
            finalCallback(self.consentData);
          }
        }
      };
    };

    const callbackTcf = makeCallback(0);
    const callbackUsp = makeCallback(1);
    this.lookupTcf(callbackTcf);
    this.lookupUsp(callbackUsp);
  }

  lookupUsp(callback) {
    const { uspapiFrame, uspapiFunction } = ConsentManagement.findUsp();
    let uspFn;
    if (!uspapiFrame) {
      logWarn(this.invocationId, 'cmpApi: USP not found! Using defaults for CCPA.');
      callback();
      return;
    }

    if (isFn(uspapiFunction)) {
      logInfo(this.invocationId, 'cmpApi: Detected USP is directly accessible, calling it now.');
      uspFn = uspapiFunction;
    } else {
      logInfo(this.invocationId, 'cmpApi: Detected USP is outside the current iframe. Using message passing.');
      uspFn = ConsentManagement.buildCmpSurrogate('uspv1', uspapiFrame);
    }

    const uspCallback = (consentResponse, success) => {
      if (success) {
        callback(ConsentManagement.parseUspData(consentResponse));
      } else {
        logError(this.invocationId, 'cmpApi: USP callback not succesful. Using defaults for CCPA.');
        callback();
      }
    };
    uspFn('getUSPData', USPAPI_VERSION, uspCallback);
  }

  /**
   * This function builds a surrogate CMP function which behaves as the original
   * except it uses message passing to communicate to the CMP function of choice
   * @param {string} typeOfCall decides how to build the function based on the CMP type
   * @param {Object} apiFrame the frame where the API is located. Discovered by detection.
   * @returns {function} the function to call
   */
  static buildCmpSurrogate(typeOfCall, apiFrame) {
    return (param0, param1, messageCallback) => {
      const callId = Math.random() + '';
      const config = SURROGATE_CONFIG[typeOfCall];
      const msg = {};
      const requestObj = {};
      requestObj[config.objKeys[0]] = param0;
      requestObj[config.objKeys[1]] = param1;
      requestObj.callId = callId;
      msg[config.objName] = requestObj;
      const eventHandler = (event) => {
        const result = delve(event, `data.${config.returnObjName}`);
        if (result && result.callId === callId) {
          window.removeEventListener('message', eventHandler);
          messageCallback(result.returnValue, result.success);
        }
      };
      window.addEventListener('message', eventHandler, false);
      apiFrame.postMessage(msg, '*');
    };
  }

  lookupTcf(callback) {
    const { cmpVersion, cmpFrame, cmpFunction } = ConsentManagement.findTCF();
    if (!cmpFrame) {
      logWarn(this.invocationId, 'cmpApi: TCF not found! Using defaults for GDPR.');
      callback();
      return;
    }

    if (isFn(cmpFunction)) {
      this.lookupDirectTcf(cmpVersion, cmpFunction, callback);
    } else {
      logInfo(this.invocationId, 'cmpApi: Detected TCF is outside the current iframe. Using message passing.');
      this.lookupMessageTcf(cmpVersion, cmpFrame, callback);
    }
  }

  lookupMessageTcf(cmpVersion, cmpFrame, callback) {
    const cmpFunction = ConsentManagement.buildCmpSurrogate(cmpVersion === 1 ? 'tcfv1' : 'tcfv2', cmpFrame);
    this.lookupDirectTcf(cmpVersion, cmpFunction, callback);
  }

  lookupDirectTcf(cmpVersion, cmpFunction, callback) {
    // TCF V1 callbacks
    const self = this;
    const cmpResponse = {};
    const done = {};
    const logcb = (version, callback, data) => {
      logInfo(self.invocationId, `cmpApi: TCFv${version} - Received a call back: ${callback}`, data);
    };
    const logNoSuccess = (version, callback) => {
      logError(self.invocationId, `cmpApi: TCFv${version} - Received insuccess: ${callback}. Please check your CMP setup. Using defaults for GDPR.`);
    };
    const makeV1Callback = (verb) => {
      done[verb] = false;
      return (data, success) => {
        done[verb] = true;
        if (!success) {
          logNoSuccess(1, verb);
        } else {
          logcb(1, verb, data);
          cmpResponse[verb] = data;
        }
        if (Object.values(done).every(d => d)) {
          callback(ConsentManagement.parseTcfData(cmpResponse, 1));
        }
      };
    };

    // TCF V2 callback
    const v2CmpResponseCallback = (tcfData, success) => {
      logcb(2, 'event', tcfData);
      if (!success) {
        logNoSuccess(2, 'addEventListener');
        callback();
        return;
      }
      if (tcfData &&
          (tcfData.gdprApplies === false ||
          tcfData.eventStatus === 'tcloaded' ||
          tcfData.eventStatus === 'useractioncomplete')
      ) {
        callback(ConsentManagement.parseTcfData(tcfData, 2));
      }
    };

    if (cmpVersion === 1) {
      const consentDataCallback = makeV1Callback('getConsentData');
      const vendorConsentsCallback = makeV1Callback('getVendorConsents');
      cmpFunction('getConsentData', null, consentDataCallback);
      cmpFunction('getVendorConsents', null, vendorConsentsCallback);
    } else if (cmpVersion === 2) {
      cmpFunction('addEventListener', cmpVersion, v2CmpResponseCallback);
    }
  }

  /**
   * This function checks the consent data provided by USP to ensure it's in an expected state.
   * @param {object} consentObject required; object returned by CMP that contains user's consent choices
   * @param {number} cmpVersion the version reported by the CMP framework
   * @returns {Object} the parsed consent data
   */
  static parseUspData(consentObject) {
    if (!isPlainObject(consentObject) ||
      !isStr(consentObject.uspString)
    ) {
      logError(this.invocationId, 'cmpApi: No or malformed USP data. Using defaults for CCPA.');
      return;
    }

    return {
      api: API_TYPE.USP_V1,
      hasCcpaString: true,
      ccpaString: consentObject.uspString
    };
  }

  /**
   * This function checks the consent data provided by CMP to ensure it's in an expected state.
   * @param {object} consentObject required; object returned by CMP that contains user's consent choices
   * @param {number} cmpVersion the version reported by the CMP framework
   * @returns {Object} the parsed consent data
   */
  static parseTcfData(consentObject, cmpVersion) {
    let isValid, normalizeFn;
    if (cmpVersion === 1) {
      isValid = ConsentManagement.isValidV1ConsentObject;
      normalizeFn = ConsentManagement.normalizeV1Data;
    } else if (cmpVersion === 2) {
      isValid = ConsentManagement.isValidV2ConsentObject;
      normalizeFn = ConsentManagement.normalizeV2Data;
    } else {
      logError(this.invocationId, 'cmpApi: No or malformed CMP data. Using defaults for GDPR.');
      return;
    }

    if (!isValid(consentObject)) {
      logError(this.invocationId, 'cmpApi: Invalid CMP data. Using defaults for GDPR.', consentObject);
      return;
    }

    return normalizeFn(consentObject);
  }

  static isValidV1ConsentObject(consentObject) {
    const gdprApplies = delve(consentObject, 'getConsentData.gdprApplies');

    if (!isBoolean(gdprApplies)) {
      return false;
    }

    if (gdprApplies === false) {
      return true;
    }

    return isStr(consentObject.getConsentData.consentData) &&
      isPlainObject(consentObject.getVendorConsents) &&
      Object.keys(consentObject.getVendorConsents).length > 1;
  }

  static isValidV2ConsentObject(consentObject) {
    const gdprApplies = consentObject &&
      consentObject.gdprApplies;
    const tcString = consentObject &&
      consentObject.tcString;

    if (gdprApplies === false) {
      return true;
    }

    return isStr(tcString);
  }

  static normalizeV1Data(cmpConsentObject) {
    return {
      consentString: cmpConsentObject.getConsentData.consentData,
      localStoragePurposeConsent: delve(cmpConsentObject, 'getVendorConsents.purposeConsents.1'),
      gdprApplies: cmpConsentObject.getConsentData.gdprApplies,
      api: API_TYPE.TCF_V1
    };
  }

  static normalizeV2Data(cmpConsentObject) {
    let decodedStorageConsent = delve(cmpConsentObject, 'purpose.consents.1');
    if (!isBoolean(decodedStorageConsent)) {
      decodedStorageConsent = isPurposeConsentSet(cmpConsentObject.tcString, 1);
    }
    return {
      consentString: cmpConsentObject.tcString,
      localStoragePurposeConsent: decodedStorageConsent,
      gdprApplies: cmpConsentObject.gdprApplies,
      api: API_TYPE.TCF_V2
    };
  }

  /**
   * Simply resets the module's consentData.
   */
  resetConsentData() {
    this.consentData = undefined;
    this.storedPrivacyData = undefined;
    this._consentRequested = false;
  }

  /**
   * Test if consent module is present, applies, and is valid for local storage or cookies (purpose 1)
   * @param {boolean} allowLocalStorageWithoutConsentApi
   * @param {boolean} debugBypassConsent
   * @returns {LocalStorageGrant} the result of checking the grant
   */
  localStorageGrant(allowLocalStorageWithoutConsentApi, debugBypassConsent) {
    if (allowLocalStorageWithoutConsentApi === true || debugBypassConsent === true) {
      logWarn(this.invocationId, 'cmpApi: Local storage access granted by configuration override, consent will not be checked');
      return new LocalStorageGrant(true, GRANT_TYPE.FORCE_ALLOWED_BY_CONFIG, API_TYPE.NONE);
    }

    if (!this.consentData || this.consentData.api === API_TYPE.NONE) {
      // Either no CMP on page or too early to say, so we check if we had stored
      // privacy data from a previous request.
      if (!isPlainObject(this.storedPrivacyData)) {
        const privacyData = this.localStorage.getItemWithExpiration(this.storageConfig.PRIVACY);
        this.storedPrivacyData = privacyData && JSON.parse(privacyData);
        logInfo(this.invocationId, 'cmpApi: Loaded stored privacy data from local storage', this.storedPrivacyData);
      }

      if (this.storedPrivacyData && this.storedPrivacyData.id5_consent === true) {
        return new LocalStorageGrant(true, GRANT_TYPE.ID5_CONSENT, API_TYPE.NONE);
      }

      if (!this.storedPrivacyData || !isDefined(this.storedPrivacyData.jurisdiction)) {
        // No stored privacy data (or jurisdiction) and no consent data. We grant provisional use.
        return new LocalStorageGrant(true, GRANT_TYPE.PROVISIONAL, API_TYPE.NONE);
      }
      // We had no id5_consent but depending on the jurisdiction, we may still grant local storage.
      const jurisdiction = this.storedPrivacyData.jurisdiction;
      const jurisdictionRequiresConsent = (jurisdiction in CONSTANTS.PRIVACY.JURISDICTIONS)
        ? CONSTANTS.PRIVACY.JURISDICTIONS[jurisdiction] : false;
      return new LocalStorageGrant(jurisdictionRequiresConsent === false, GRANT_TYPE.JURISDICTION, API_TYPE.NONE);
    }

    return this.consentData.localStorageGrant();
  }

  setStoredPrivacy(privacy) {
    try {
      if (isPlainObject(privacy)) {
        this.storedPrivacyData = privacy;
        this.localStorage.setItemWithExpiration(this.storageConfig.PRIVACY,
          JSON.stringify(privacy));
      } else {
        logError(this.invocationId, 'cmpApi: Cannot store privacy data if it is not an object', privacy);
      }
    } catch (e) {
      logError(this.invocationId, 'cmpApi: Error while storing privacy data', e);
    }
  }

  /**
   * @typedef {Object} CMPDetails
   * @property {number} cmpVersion - Version of CMP Found, 0 if not found
   * @property {Object} cmpFrame - The frame where the CPM function is declared
   * @property {function} cmpFunction - the CMP function to invoke
   *
   * This function tries to find the CMP in page.
   * @return {CMPDetails}
   */
  static findTCF() {
    let cmpVersion = 0;
    let f = window;
    let cmpFrame;
    let cmpFunction;
    while (!cmpFrame) {
      try {
        if (typeof f.__tcfapi === 'function' || typeof f.__cmp === 'function') {
          if (typeof f.__tcfapi === 'function') {
            cmpVersion = 2;
            cmpFunction = f.__tcfapi;
          } else {
            cmpVersion = 1;
            cmpFunction = f.__cmp;
          }
          cmpFrame = f;
          break;
        }
      } catch (e) { }

      // need separate try/catch blocks due to the exception errors
      // thrown when trying to check for a frame that doesn't exist
      // in 3rd party env
      try {
        if (f.frames['__tcfapiLocator']) {
          cmpVersion = 2;
          cmpFrame = f;
          break;
        }
      } catch (e) { }

      try {
        if (f.frames['__cmpLocator']) {
          cmpVersion = 1;
          cmpFrame = f;
          break;
        }
      } catch (e) { }

      if (f === window.top) break;
      f = f.parent;
    }
    return {
      cmpVersion,
      cmpFrame,
      cmpFunction
    };
  }

  /**
   * @typedef {Object} UspDetails
   * @property {Object} uspapiFrame - The frame where the CPM function is declared
   * @property {function} uspapiFunction - the CMP function to invoke
   *
   * This function tries to find the CMP in page.
   * @return {UspDetails}
   */
  static findUsp() {
    let f = window;
    let uspapiFrame;
    let uspapiFunction;

    while (!uspapiFrame) {
      try {
        if (typeof f.__uspapi === 'function') {
          uspapiFunction = f.__uspapi;
          uspapiFrame = f;
          break;
        }
      } catch (e) {}

      try {
        if (f.frames['__uspapiLocator']) {
          uspapiFrame = f;
          break;
        }
      } catch (e) {}
      if (f === window.top) break;
      f = f.parent;
    }
    return {
      uspapiFrame,
      uspapiFunction
    };
  }
}
