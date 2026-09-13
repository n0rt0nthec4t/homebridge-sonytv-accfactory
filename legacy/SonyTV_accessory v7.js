// HAP-Nodejs Sony Brava TV
// 
// https://pro-bravia.sony.net/develop/
//
// todo 
// -- Dynamic removal/addition of inputs into HomeKit
// -- Remote play/pause functionallity
// -- Update input names during status updates
// -- Prefix or suffix to input channel/application names
//
// done
// -- Update firmware version during status updates
// -- Bug fix: getting speaker volume/mute status
// -- Build list of applications on TV as HomeKit inputs
//
// Version 23/10/2019
// Mark Hulskamp

var Accessory = require('../').Accessory; 
var Service = require('../').Service;
var Characteristic = require('../').Characteristic;
var uuid = require('../').uuid;
var request = require('sync-request');

// Defines for the accessory
const AccessoryName =  "Television";                   // name of accessory
const AccessoryPincode = "031-45-154";                 // pin code for paring  

const SonyTVIP = "10.0.1.104";                         // IP address for TV
const SonyTVPSK = "0000";                              // PSK key

// Define some extra remote commands
Characteristic.RemoteKey.SETTINGS = 101;
Characteristic.RemoteKey.PLAY = 102;
Characteristic.RemoteKey.PAUSE = 102;


// Create the TV system object. This can be used as the template for multiple aircons under the one accessory
function SonyTVClass() {
    this.__accessory = null;                    // Parent accessory object
    this.__IPAddress = "";                      // IP Address of TV
    this.__TVService = null;                    // HomeKit service for the TV
    this.__SpeakerService = null;               // HomeKit service for the TV speaker
    this.__RemoteCommands = [];                 // List of remote commands for this TV
    this.__TVInputs = [];                       // array of input objects.
    this.__refreshTimer = null;                 // update loop timer
    this.__waitSetInput = null;                 // cache input if selected while TV is off.. We'll set this input when TV is turned on
    this.__updatingHomeKit = false;
}

function InputClass() {
    this.__ID = null;
    this.__InputService = null;
    this.__uri = null;
}

SonyTVClass.prototype = {
    addTelevison: function(HomeKitAccessory, thisServiceName, serviceNumber) {
        this.__TVService = HomeKitAccessory.addService(Service.Television, thisServiceName, serviceNumber);
        this.__TVService.setCharacteristic(Characteristic.ConfiguredName, thisServiceName);
        this.__TVService.setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

        // Add the TV speaker as a service
        this.__SpeakerService = HomeKitAccessory.addService(Service.TelevisionSpeaker);
        this.__SpeakerService.setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.ABSOLUTE);

        // Setup call backs
        this.__TVService.getCharacteristic(Characteristic.Active).on('set', this.setPowerState.bind(this));
        this.__TVService.getCharacteristic(Characteristic.ActiveIdentifier).on('set', this.setActiveInput.bind(this));
        this.__TVService.getCharacteristic(Characteristic.RemoteKey).on('set', this.sendRemoteKey.bind(this));
        this.__SpeakerService.getCharacteristic(Characteristic.VolumeSelector).on('set', this.setVolume.bind(this));
        this.__TVService.getCharacteristic(Characteristic.PowerModeSelection).on('set', this.accessTVSettings.bind(this));

        // Build list of inputs for both physical and applicaions        
        this.__buildRemoteCmdList();
        this.__buildInputList(false, false);

        // Force HomeKit update for inital state
        this.__SonyTVStatus();
   
        console.log("Setup Sony Television '%s' on '%s'", thisServiceName, HomeKitAccessory.username);
        return this.__TVService;   // Return object to this service
    },

    setPowerState: function(state, callback)
    {
        this.__updatingHomeKit = true;
        
        // Turns on/off the TV
        var response = request("POST", "http://" + this.__IPAddress + "/sony/system", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "setPowerStatus", "id": 55, "params": [{"status": (state == Characteristic.Active.ACTIVE) ? true : false}], "version": "1.0"} });
        if (response.statusCode == 200) {
            // Reflect active state for the speaker service also
            if (this.__SpeakerService != null) {
                this.__SpeakerService.getCharacteristic(Characteristic.Active).updateValue(state);
            }

            // See if we have a cached input to set if status is power on
            if (this.__waitSetInput != null && state == Characteristic.Active.ACTIVE) {
                this.__TVService.getCharacteristic(Characteristic.ActiveIdentifier).setValue(this.__waitSetInput);
                this.__waitSetInput = null;
            } 
            callback(); // set power state
        }
        this.__updatingHomeKit = false;
    },

    setActiveInput: function(inputID, callback)
    {
        this.__updatingHomeKit = true;

        // Switches inputs on the TV
        for (var index in this.__TVInputs) {
            // search thru the input list to work out which input is to be selected
            if (inputID == this.__TVInputs[index].__ID) {
                var response = request("POST", "http://" + this.__IPAddress + "/sony/avContent", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "setPlayContent", "id": 13, "params": [{"uri": this.__TVInputs[index].__uri}],  "version": "1.0"} });
                if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
                } else {
                    // REST API post failed, so cache value we wanted to set
                    this.__waitSetInput = inputID;
                }
            }
        }

        callback(); // set input      
        this.__updatingHomeKit = false;
    },

    sendRemoteKey: function(value, callback) {
        if (this.__RemoteCommands[value] !== "undefined" && this.__RemoteCommands[value] != "") {
            var IRCCBodyRequest = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>' + this.__RemoteCommands[value] + '</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>';
            var response = request("POST", "http://" + this.__IPAddress + "/sony/IRCC", {headers: {"X-Auth-PSK": SonyTVPSK, "Content-Type": "text/xml", "soapaction": '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"'}, body: IRCCBodyRequest });
        }
        callback(); // sent remote command
    },

    setVolume: function(value, callback) {
        this.__updatingHomeKit = true;
        var response = request("POST", "http://" + this.__IPAddress + "/sony/audio", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "setAudioVolume", "id": 601, "params": [{"target": "speaker", "volume": (value == Characteristic.VolumeSelector.INCREMENT ? "+1" : "-1")}],  "version": "1.0"} });
        if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
        }
        callback(); // set volume
        this.__updatingHomeKit = false;
    },

    accessTVSettings: function(value, callback) {
        if (value == Characteristic.PowerModeSelection.SHOW && this.__RemoteCommands[Characteristic.RemoteKey.SETTINGS] !== "undefined" && this.__RemoteCommands[Characteristic.RemoteKey.SETTINGS] != "") {
            var IRCCBodyRequest = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>' + this.__RemoteCommands[Characteristic.RemoteKey.SETTINGS] + '</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>';
            var response = request("POST", "http://" + this.__IPAddress + "/sony/IRCC", {headers: {"X-Auth-PSK": SonyTVPSK, "Content-Type": "text/xml", "soapaction": '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"'}, body: IRCCBodyRequest });
            if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
            }
        }
        callback(); // accessed TV settings
    },

    setTVInputName: function(value, callback) {  
        this.__updatingHomeKit = true; 
        
        // Update TV inputs name in HomeKit
        this.__InputService.getCharacteristic(Characteristic.ConfiguredName).updateValue(value);
        callback();
        this.__updatingHomeKit = false;
    },

    hideShowTVInputs: function(state, callback) {
        this.__updatingHomeKit = true;

        // Allow enabling/disble input section in homekit
        this.__InputService.getCharacteristic(Characteristic.CurrentVisibilityState).updateValue(state);
        this.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).updateValue(state);

        // See if we can mirror the hide/show status of an input directly on the TV??
        callback();
        this.__updatingHomeKit = false;
    },

    refreshHomeKit: function(refreshTimeMS) {
        // setup status check interval as defined
        if (this.__refreshTimer != null) {
            // current update timer running, so cancel it.
            clearInterval(this.__refreshTimer);
            this.__refreshTimer = null;
        }
        this.__refreshTimer = setInterval(this.__SonyTVStatus.bind(this), refreshTimeMS); 
        console.log("Refresh status in HomeKit set for every '%s'ms", refreshTimeMS);
    },

    __buildRemoteCmdList: function() {
        // Create mapping of available remote commands so we can use in HomeKit remote app
        var response = request("POST", "http://" + this.__IPAddress + "/sony/system", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getRemoteControllerInfo", "id": 1, "params": [""],  "version": "1.0"} });
        if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
            var tempRemoteList = JSON.parse(response.body).result[1];
            this.__RemoteCommands = [];
            for (var index in tempRemoteList) {
                switch (tempRemoteList[index].name.toUpperCase()) {
                    case "REWIND" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.REWIND] = tempRemoteList[index].value;
                        break;
                    }

                    case "FORWARD" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.FAST_FORWARD] = tempRemoteList[index].value;
                        break;
                    }

                    case "NEXT" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.NEXT_TRACK] = tempRemoteList[index].value;
                        break;
                    }

                    case "PREV" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.PREVIOUS_TRACK] = tempRemoteList[index].value;
                        break;
                    }

                    case "UP" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.ARROW_UP] = tempRemoteList[index].value;
                        break;
                    }

                    case "DOWN" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.ARROW_DOWN] = tempRemoteList[index].value;
                        break;
                    }

                    case "LEFT" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.ARROW_LEFT] = tempRemoteList[index].value;
                        break;
                    }

                    case "RIGHT" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.ARROW_RIGHT] = tempRemoteList[index].value;
                        break;
                    }

                    case "CONFIRM" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.SELECT] = tempRemoteList[index].value;
                        break;
                    }

                    case "RETURN" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.BACK] = tempRemoteList[index].value;
                        break;
                    }

                    case "EXIT" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.EXIT] = tempRemoteList[index].value;
                        break;
                    }

                    case "PLAY" : {
                        //this.__RemoteCommands[Characteristic.RemoteKey.PLAY] = tempRemoteList[index].value;
                        break;
                    }

                    case "PAUSE" :
                    {
                        //this.__RemoteCommands[Characteristic.RemoteKey.PAUSE] = tempRemoteList[index].value;
                        break;
                    }

                    case "DISPLAY" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.INFORMATION] = tempRemoteList[index].value;
                        break;
                    }

                    case "ACTIONMENU" :
                    {
                        this.__RemoteCommands[Characteristic.RemoteKey.SETTINGS] = tempRemoteList[index].value;
                        break;
                    }
                }
            }
        } 
    },

    __buildInputList: function(includeChannels, includeApplications) {
        // Build and setup HomeKit objects for the available inputs on the TV
        var response = request("POST", "http://" + this.__IPAddress + "/sony/avContent", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getCurrentExternalInputsStatus", "id": 105, "params": [""], "version": "1.0"} });
        if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
            var tempTVInputList = JSON.parse(response.body).result[0];
            for (var index in tempTVInputList) {
                var tempInput = new InputClass();
                tempInput.__ID = this.__TVInputs.length;
                tempInput.__InputService = this.__accessory.addService(Service.InputSource, tempTVInputList[index].title, tempInput.__ID);
                tempInput.__uri = tempTVInputList[index].uri;
                tempInput.__InputService.setCharacteristic(Characteristic.ConfiguredName, ((tempTVInputList[index].label == "") ? tempTVInputList[index].title : tempTVInputList[index].title + " (" + tempTVInputList[index].label + ")"));
                tempInput.__InputService.setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED);
                tempInput.__InputService.setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);
                tempInput.__InputService.setCharacteristic(Characteristic.TargetVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);    
                tempInput.__InputService.setCharacteristic(Characteristic.Identifier, tempInput.__ID);

                // Determine the input type by the "icon" tag. Split after the "meta:" entry for the type
                switch(tempTVInputList[index].icon.split(":")[1].toUpperCase())
                {
                    case "HDMI" :
                    {
                        tempInput.__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.HDMI);
                        break
                    }

                    case "COMPONENT" :
                    {
                        tempInput.__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.COMPONENT_VIDEO);
                        break
                    }

                    case "COMPOSITE" :
                    {
                        tempInput.__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.COMPOSITE_VIDEO);
                        break
                    }

                    case "SVIDEO" :
                    {
                        tempInput.__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.S_VIDEO);
                        break
                    }

                    case "WIFIDISPLAY" :
                    {
                        tempInput.__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.AIRPLAY);
                        break
                    }
                }
                tempInput.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).on('set', this.hideShowTVInputs.bind(tempInput));
                tempInput.__InputService.getCharacteristic(Characteristic.ConfiguredName).on('set', this.setTVInputName.bind(tempInput));
                this.__TVService.addLinkedService(tempInput.__InputService);
                this.__TVInputs.push(tempInput);  // add to array of inputs
            }
        }

        // Add input(s) for any tuners. These dont appear in the list of external inputs, so we use another call to see whats defined        
        var response = request("POST", "http://" + this.__IPAddress + "/sony/avContent", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getSourceList", "id": 1, "params": [{"scheme": "tv"}], "version": "1.0"} });
        if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
            var tempTunerList = JSON.parse(response.body).result[0];
            for (var index in tempTunerList ) {
                var tempInputName = "";
                if (tempTunerList[index].source.toUpperCase() == "TV:DVBT") tempInputName = "Digital Tuner";
                if (tempTunerList[index].source.toUpperCase() == "TV:ANALOG") tempInputName = "Analog Tuner";
                if (tempTunerList[index].source.toUpperCase() == "TV:DVBC") tempInputName = "Cable Tuner";
                if (tempTunerList[index].source.toUpperCase() == "TV:DVBS") tempInputName = "Satellite Tuner";
                if (tempInputName != "") {
                    var tempInput = new InputClass();
                    tempInput.__ID = this.__TVInputs.length;
                    tempInput.__InputService = this.__accessory.addService(Service.InputSource, tempInputName, tempInput.__ID);
                    tempInput.__uri = tempTunerList[index].source;
                    tempInput.__InputService.setCharacteristic(Characteristic.ConfiguredName, tempInputName);
                    tempInput.__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.TUNER);
                    tempInput.__InputService.setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED);
                    tempInput.__InputService.setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);
                    tempInput.__InputService.setCharacteristic(Characteristic.TargetVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);
                    tempInput.__InputService.setCharacteristic(Characteristic.Identifier, tempInput.__ID);
                    tempInput.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).on('set', this.hideShowTVInputs.bind(tempInput));
                    tempInput.__InputService.getCharacteristic(Characteristic.ConfiguredName).on('set', this.setTVInputName.bind(tempInput));
                    this.__TVService.addLinkedService(tempInput.__InputService);
                    this.__TVInputs.push(tempInput);  // add to array of inputs

                    // For each discovered tuner, include channels as inputs in HomeKit
                    // Seems if there are alot of channels, does slow down interacting with the accesssory settings intially in HomeKit
                    // Todo
                    // -- Maybe put suffix or prefix to channel name to show which input attached ie: digital, cable, satellite etc
                    if (includeChannels == true) {
                        var response = request("POST", "http://" + this.__IPAddress + "/sony/avContent", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getContentList", "id": 2, "params": [{"source": tempInputList[index].source, "stIx": 0}], "version": "1.2"} });
                        if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
                            var tempChannelList = JSON.parse(response.body).result[0];
                            for (var index2 in tempChannelList) {
                                //tempChannelList[index2].programMediaType == "tv";
                                //tempChannelList[index2].programMediaType == "radio";

                                var tempInput = new InputClass();
                                tempInput.__ID = this.__TVInputs.length;
                                tempInput.__InputService = this.__accessory.addService(Service.InputSource, tempChannelList[index2].title, tempInput.__ID );
                                tempInput.__uri = tempChannelList[index2].uri;
                                tempInput.__InputService.setCharacteristic(Characteristic.ConfiguredName, tempChannelList[index2].title);
                                tempInput.__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.OTHER); // Maybe Characteristic.InputSourceType.APPLICATION??
                                tempInput.__InputService.setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED);
                                tempInput.__InputService.setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);
                                tempInput.__InputService.setCharacteristic(Characteristic.TargetVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);
                                tempInput.__InputService.setCharacteristic(Characteristic.Identifier, tempInput.__ID);
                                tempInput.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).on('set', this.hideShowTVInputs.bind(tempInput));
                                tempInput.__InputService.getCharacteristic(Characteristic.ConfiguredName).on('set', this.setTVInputName.bind(tempInput));
                                this.__TVService.addLinkedService(tempInput.__InputService);
                                this.__TVInputs.push(tempInput);  // add to array of inputs
                            }
                        }
                    }
                }
            }
        }

        // Build application list
        // Seems if there are alot of channels, does slow down interacting with the accesssory settings intially in HomeKit
        // Todo
        // -- Maybe put suffix or prefix to application name to show input as application??
        if (includeApplications == true) {
            var response = request("POST", "http://" + this.__IPAddress + "/sony/appControl", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getApplicationList", "id": 60, "params": [""], "version": "1.0"} });
            if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
                var tempApplicationList = JSON.parse(response.body).result[0];
                for (var index in tempApplicationList) {
                    var tempInput = new InputClass();
                    tempInput.__ID = this.__TVInputs.length;
                    tempInput.__InputService = this.__accessory.addService(Service.InputSource, tempApplicationList[index].title, tempInput.__ID);
                    tempInput.__uri = tempApplicationList[index].uri;
                    tempInput.__InputService.setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.APPLICATION);
                    tempInput.__InputService.setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED);
                    tempInput.__InputService.setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);
                    tempInput.__InputService.setCharacteristic(Characteristic.TargetVisibilityState, Characteristic.CurrentVisibilityState.SHOWN);
                    tempInput.__InputService.setCharacteristic(Characteristic.Identifier, tempInput.__ID);
                    tempInput.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).on('set', this.hideShowTVInputs.bind(tempInput));
                    this.__TVService.addLinkedService(tempInput.__InputService);
                    this.__TVInputs.push(tempInput);  // add to array of inputs
                }
            }
        }     
    },

    __SonyTVStatus: function() {
        const scale = (num, in_min, in_max, out_min, out_max) => {
            if (num > out_max) num = out_max;
            if (num < out_min) num = out_min;
            return (num - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
        }

        if (this.__updatingHomeKit == false) {
            try {
                // Get power status
                var response = request("POST", "http://" + this.__IPAddress + "/sony/system", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getPowerStatus", "id": 50, "params": [""],  "version": "1.0"} });
                if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
                    this.__TVService.getCharacteristic(Characteristic.Active).updateValue((JSON.parse(response.body).result[0].status.toUpperCase() == "ACTIVE" ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE));

                    if (JSON.parse(response.body).result[0].status.toUpperCase() == "ACTIVE" && this.__waitSetInput != null) {
                        // TVs been switched on externally to HomeKit and we have an "cached input value. We'll clear the cached value in this case and let the loop below update the current state
                        this.__waitSetInput = null;
                    }
                }

                // Get active input
                var response = request("POST", "http://" + this.__IPAddress + "/sony/avContent", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getPlayingContentInfo", "id": 103, "params": [""],  "version": "1.0"} });
                if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
                    for (var index in this.__TVInputs) {
                        // search through the input list to work out which input is selected
                        if ((JSON.parse(response.body).result[0].uri == this.__TVInputs[index].__uri) || (JSON.parse(response.body).result[0].source.substr(0,3).toUpperCase() == "TV:" && JSON.parse(response.body).result[0].source == this.__TVInputs[index].__uri)) {
                            this.__TVService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(this.__TVInputs[index].__ID);
                        }
                    }
                } else if (this.__waitSetInput != null) {
                    // since we got an error requesting inputs, we assume TV is off.. So if we have an input waiting to be set with the physcial TV, update that to reflect in HomeKit
                    this.__TVService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(this.__waitSetInput);
                }

                // get volume information
                var response = request("POST", "http://" + this.__IPAddress + "/sony/audio", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getVolumeInformation", "id": 33, "params": [""],  "version": "1.0"} });
                if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
                    var tempVolumeInfo = JSON.parse(response.body).result[0];
                    for (var index in tempVolumeInfo)
                    {
                        if (tempVolumeInfo[index].target.toUpperCase() == "SPEAKER")
                        {
                            // Scale volume
                            this.__SpeakerService.getCharacteristic(Characteristic.Volume).updateValue(scale(tempVolumeInfo[index].volume, tempVolumeInfo[index].minVolume, tempVolumeInfo[index].maxVolume, 0, 100));
                            this.__SpeakerService.getCharacteristic(Characteristic.Mute).updateValue(tempVolumeInfo[index].mute);
                        }
                    }
                }

                // Update firmware version
                var response = request("POST", "http://" + this.__IPAddress + "/sony/system", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getSystemInformation", "id": 33, "params": [""], "version": "1.0"} });
                if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
                    this.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, JSON.parse(response.body).result[0].generation);
                }

                // Update input names
                var response = request("POST", "http://" + this.__IPAddress + "/sony/avContent", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getCurrentExternalInputsStatus", "id": 105, "params": [""], "version": "1.0"} });
                if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
                    var tempInputList = JSON.parse(response.body).result[0];
                    for (var index in tempInputList) {
                            // todo
                    }
                }
            } catch (ex) {
                // Getting updates from Nest API threw an exception
                console.log("DEBUG: ", AccessoryName, ex);
            }
        }
    }
}

var response = request("POST", "http://" + SonyTVIP + "/sony/system", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getSystemInformation", "id": 33, "params": [""], "version": "1.0"} });
if (response.statusCode == 200 && typeof JSON.parse(response.body).result !== 'undefined') {
    var SonyTVSystemInfo = JSON.parse(response.body).result[0];
    var SonyTV = new SonyTVClass();
    SonyTV.__accessory = exports.accessory = new Accessory("Sony " + SonyTVSystemInfo.model, uuid.generate("hap-nodejs:accessories:sony_" + SonyTVSystemInfo.serial));
    SonyTV.__accessory.username = SonyTVSystemInfo.macAddr; // We'll use the TVs mac address for the HomeKit one 
    SonyTV.__accessory.pincode = AccessoryPincode;
    SonyTV.__accessory.category = Accessory.Categories.TELEVISION;  // Television type acessory
    SonyTV.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, "Sony");
    SonyTV.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, SonyTVSystemInfo.model);
    SonyTV.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, SonyTVSystemInfo.serial);
    SonyTV.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, SonyTVSystemInfo.generation);

    SonyTV.__IPAddress = SonyTVIP;  // Store IP address of the TV for later calls
    SonyTV.addTelevison(SonyTV.__accessory, "Sony " + SonyTVSystemInfo.model, 1);
    SonyTV.refreshHomeKit(5000);    // Refresh HomeKit every 5 seconds
}