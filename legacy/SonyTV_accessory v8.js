// HAP-Nodejs Sony Brava TV
// 
// https://pro-bravia.sony.net/develop/
//
// todo 
// -- Dynamic removal/addition of inputs into HomeKit
// -- Remote play/pause functionallity
// -- Update input names during status updates
// -- Prefix or suffix to input channel/application names
// -- Remove hard-coded IPs
// -- Multiple accessories for each TV discovered
//
// done
// -- partly switched to axios library
// -- Update firmware version during status updates
// -- Bug fix: getting speaker volume/mute status
// -- Build list of applications on TV as HomeKit inputs
//
// Version 2/4/2019
// Mark Hulskamp

var Accessory = require('../').Accessory; 
var Service = require('../').Service;
var Characteristic = require('../').Characteristic;
var uuid = require('../').uuid;
var request = require('sync-request');
var axios = require("axios");

// Defines for the accessory
const AccessoryName =  "Television";                   // name of accessory
const AccessoryPincode = "031-45-154";                 // pin code for paring  

const SonyTVIP = "10.0.1.104";                         // IP address for TV
const SonyTVPSK = "0000";                              // PSK key

const TVTURNONDELAY = 2000;

// Define some extra remote commands
Characteristic.RemoteKey.SETTINGS = 101;
Characteristic.RemoteKey.PLAY = 102;
Characteristic.RemoteKey.PAUSE = 102;
Characteristic.RemoteKey.HOME = 103;


// Create the TV system object. This can be used as the template for multiple aircons under the one accessory
function SonyTVClass() {
    this.__accessory = null;                    // Parent accessory object
    this.__IPAddress = "";                      // IP Address of TV
    this.__TVService = null;                    // HomeKit service for the TV
    this.__SpeakerService = null;               // HomeKit service for the TV speaker
    this.__RemoteCommands = [];                 // List of remote commands for this TV
    this.__TVInputs = [];                       // array of input objects.
    this.__refreshTimeout = null;
    this.__updatingHomeKit = false;
    this.__cachedPowerState = null;
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
  
        console.log("Setup Sony Television '%s' on '%s'", thisServiceName, HomeKitAccessory.username);
    },

    setPowerState: function(value, callback)
    {
        this.__updatingHomeKit = true;
        this.__cachedPowerState = null;
        
        // Turns on/off the TV
        axios.post("http://" + this.__IPAddress + "/sony/system", {"method": "setPowerStatus", "id": 55, "params": [{"status": (value == Characteristic.Active.ACTIVE) ? true : false}], "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}})
        .then(response => {
            if (response.status = 200) {
                // Reflect active state for the speaker service also
                if (this.__SpeakerService != null) {
                    this.__SpeakerService.getCharacteristic(Characteristic.Active).updateValue(value);
                }

                // See if we have a cached input to set if status is power on
                if (this.__waitSetInput != null && state == Characteristic.Active.ACTIVE) {
                    this.__TVService.getCharacteristic(Characteristic.ActiveIdentifier).setValue(this.__waitSetInput);
                    this.__waitSetInput = null;
                }
            }
        })
        .finally(() => {
            this.__cachedPowerState = value;    // Cache the power state we set for update loop.. Allows updated HomeKit status correctly as TV takes a few seconds to return its turn power state if queried
            setTimeout(function() {
                this.__cachedPowerState = null;
            }.bind(this), TVTURNONDELAY);

            callback(); // set power state
            this.__updatingHomeKit = false;
        })
        .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));
    },

    setActiveInput: function(value, callback)
    {
        this.__updatingHomeKit = true;

        // Switches inputs on the TV
        this.__TVInputs.forEach(TVInput => {
            // search thru the input list to work out which input is to be selected
            if (value == TVInput.__ID) {
                axios.post("http://" + this.__IPAddress + "/sony/avContent", {"method": "setPlayContent", "id": 13, "params": [{"uri": TVInput.__uri}],  "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}})
                .then(response => {
                    if (response.status != 200 || response.data.error) {
                        // REST API post failed, so cache value we wanted to set
                        this.__waitSetInput = value;
                    }
                })
                .finally(() => {
                    callback(); // set input
                    this.__updatingHomeKit = false;
                })
                .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));
            }
        });
    },

    sendRemoteKey: function(value, callback) {
        // TODO - handle special case on play/puase which HomeKit sends, rather than seperate Play and pause commands Sony accepts
        if (this.__RemoteCommands[value] && this.__RemoteCommands[value] != "") {
            // send remote command
            var IRCCBodyRequest = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>' + this.__RemoteCommands[value] + '</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>';
            axios.post("http://" + this.__IPAddress + "/sony/IRCC", IRCCBodyRequest, {headers: {"X-Auth-PSK": SonyTVPSK, "Content-Type": "text/xml", "soapaction": '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"'}})
            .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));
        }
        if (typeof callback === 'function') callback();  // do callback if defined
    },

    setVolume: function(value, callback) {
        this.__updatingHomeKit = true;
        axios.post("http://" + this.__IPAddress + "/sony/audio", {"method": "setAudioVolume", "id": 601, "params": [{"target": "speaker", "volume": (value == Characteristic.VolumeSelector.INCREMENT ? "+1" : "-1")}],  "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}})
        .finally(() => {
            callback(); // set volume
            this.__updatingHomeKit = false;
        })
        .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));
    },

    accessTVSettings: function(value, callback) {
        if (value == Characteristic.PowerModeSelection.SHOW && this.__RemoteCommands[Characteristic.RemoteKey.SETTINGS] && this.__RemoteCommands[Characteristic.RemoteKey.SETTINGS] != "") {
           this.sendRemoteKey(Characteristic.RemoteKey.SETTINGS, null);
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

    hideShowTVInputs: function(value, callback) {
        this.__updatingHomeKit = true;

        // Allow enabling/disble input section in homekit
        this.__InputService.getCharacteristic(Characteristic.CurrentVisibilityState).updateValue(value);
        this.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).updateValue(value);

        // See if we can mirror the hide/show status of an input directly on the TV??
        callback();
        this.__updatingHomeKit = false;
    },

    refreshHomeKit: function(refreshTimeMS) {
        // setup status check interval as defined
        this.__refreshTimeout = refreshTimeMS;
        this.__updateHomeKit(true);
        console.log("Refresh status in HomeKit set for every '%s'ms", refreshTimeMS);
    },

    __buildRemoteCmdList: function() {
        // Create mapping of available remote commands so we can use in HomeKit remote app
        axios.post("http://" + this.__IPAddress + "/sony/system", {"method": "getRemoteControllerInfo", "id": 1, "params": [""],  "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}})
        .then(response => {
            if (response.status == 200 && response.data.result) {
                this.__RemoteCommands = [];
                response.data.result[1].forEach(remoteCommand => {
                    switch (remoteCommand.name.toUpperCase()) {
                        case "REWIND" :
                        {
                            this.__RemoteCommands[Characteristic.RemoteKey.REWIND] = remoteCommand.value;
                            break;
                        }

                        case "FORWARD" :
                        {
                            this.__RemoteCommands[Characteristic.RemoteKey.FAST_FORWARD] = remoteCommand.value;
                            break;
                        }

                        case "NEXT" :
                        {
                            this.__RemoteCommands[Characteristic.RemoteKey.NEXT_TRACK] = remoteCommand.value;
                            break;
                        }

                        case "PREV" :
                        {
                            this.__RemoteCommands[Characteristic.RemoteKey.PREVIOUS_TRACK] = remoteCommand.value;
                            break;
                        }

                        case "UP" :
                        {
                            this.__RemoteCommands[Characteristic.RemoteKey.ARROW_UP] = remoteCommand.value;
                            break;
                        }

                        case "DOWN" :
                        {
                            this.__RemoteCommands[Characteristic.RemoteKey.ARROW_DOWN] = remoteCommand.value;
                            break;
                        }

                        case "LEFT" :
                        {
                            this.__RemoteCommands[Characteristic.RemoteKey.ARROW_LEFT] = remoteCommand.value;
                            break;
                        }

                        case "RIGHT" :
                        {
                            this.__RemoteCommands[Characteristic.RemoteKey.ARROW_RIGHT] = remoteCommand.value;
                            break;
                        }

                        case "CONFIRM" :
                        {
                            this.__RemoteCommands[Characteristic.RemoteKey.SELECT] = remoteCommand.value;
                            break;
                        }

                        case "RETURN" :
                        {
                            this.__RemoteCommands[Characteristic.RemoteKey.BACK] = remoteCommand.value;
                            break;
                        }

                        case "EXIT" :
                        {
                            this.__RemoteCommands[Characteristic.RemoteKey.EXIT] = remoteCommand.value;
                            break;
                        }

                        case "PLAY" : {
                            //Characteristic.RemoteKey.PLAY_PAUSE
                            this.__RemoteCommands[Characteristic.RemoteKey.PLAY] = remoteCommand.value;
                            break;
                        }

                        case "PAUSE" :
                        {
                            //Characteristic.RemoteKey.PLAY_PAUSE
                            this.__RemoteCommands[Characteristic.RemoteKey.PAUSE] = remoteCommand.value;
                            break;
                        }

                        case "DISPLAY" :
                        {
                            this.__RemoteCommands[Characteristic.RemoteKey.INFORMATION] = remoteCommand.value;
                            break;
                        }

                        case "ACTIONMENU" :
                        {
                            this.__RemoteCommands[Characteristic.RemoteKey.SETTINGS] = remoteCommand.value;
                            break;
                        }

                        case "HOME" :
                        {
                            this.__RemoteCommands[Characteristic.RemoteKey.HOME] = remoteCommand.valu
                            break;
                        }
                    }
                });
            }
        })
        .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));
    },

    __buildInputList: function(includeChannels, includeApplications) {
        // Build and setup HomeKit objects for the available inputs on the TV
        var response = request("POST", "http://" + this.__IPAddress + "/sony/avContent", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getCurrentExternalInputsStatus", "id": 105, "params": [""], "version": "1.0"} });
        if (response.statusCode == 200 && JSON.parse(response.body).result[0]) {
            JSON.parse(response.body).result[0].forEach(TVInput => {
                var tempInput = new InputClass();
                tempInput.__ID = this.__TVInputs.length;
                tempInput.__InputService = this.__accessory.addService(Service.InputSource, TVInput.title, (this.__TVInputs.length + 1));
                tempInput.__uri = TVInput.uri;
                tempInput.__InputService.getCharacteristic(Characteristic.ConfiguredName).updateValue(((TVInput.label == "") ? TVInput.title : TVInput.title + " (" + TVInput.label + ")"));
                tempInput.__InputService.getCharacteristic(Characteristic.IsConfigured).updateValue(Characteristic.IsConfigured.CONFIGURED);
                tempInput.__InputService.getCharacteristic(Characteristic.CurrentVisibilityState).updateValue(Characteristic.CurrentVisibilityState.SHOWN);
                tempInput.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).updateValue(Characteristic.CurrentVisibilityState.SHOWN);    
                tempInput.__InputService.getCharacteristic(Characteristic.Identifier).updateValue(tempInput.__ID);

                // Determine the input type by the "icon" tag. Split after the "meta:" entry for the type
                switch(TVInput.icon.split(":")[1].toUpperCase())
                {
                    case "HDMI" :
                    {
                        tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.HDMI);
                        break
                    }

                    case "COMPONENT" :
                    case "COMPONENTD" :
                    {
                        tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.COMPONENT_VIDEO);
                        break
                    }

                    case "COMPOSITE" :
                    {
                        tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.COMPOSITE_VIDEO);
                        break
                    }

                    case "SVIDEO" :
                    {
                        tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.S_VIDEO);
                        break
                    }

                    case "WIFIDISPLAY" :
                    {
                        tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.AIRPLAY);
                        break
                    }

                    case "TUNERDEVICE" :
                    case "TV" :
                    case "TUNER" :
                    {
                        tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.TUNER);
                        break
                    }

                    default : 
                    {
                        tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.OTHER);
                        console.log("DEBUG: Got a input type we dont handle", TVInput.icon.split(":")[1].toUpperCase());
                        break;
                    }
                }
                tempInput.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).on('set', this.hideShowTVInputs.bind(tempInput));
                tempInput.__InputService.getCharacteristic(Characteristic.ConfiguredName).on('set', this.setTVInputName.bind(tempInput));
                this.__TVService.addLinkedService(tempInput.__InputService);
                this.__TVInputs.push(tempInput);  // add to array of inputs
            });
        }

        // Add input(s) for any tuners. These dont appear in the list of external inputs, so we use another call to see whats defined        
        var response = request("POST", "http://" + this.__IPAddress + "/sony/avContent", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getSourceList", "id": 1, "params": [{"scheme": "tv"}], "version": "1.0"} });
        if (response.statusCode == 200 && JSON.parse(response.body).result[0]) {
            JSON.parse(response.body).result[0].forEach(TVTuner => {
                var tempInputName = "";
                if (TVTuner.source.toUpperCase() == "TV:DVBT") tempInputName = "Digital Tuner";
                if (TVTuner.source.toUpperCase() == "TV:ANALOG") tempInputName = "Analog Tuner";
                if (TVTuner.source.toUpperCase() == "TV:DVBC") tempInputName = "Cable Tuner";
                if (TVTuner.source.toUpperCase() == "TV:DVBS") tempInputName = "Satellite Tuner";
                if (tempInputName != "") {
                    var tempInput = new InputClass();
                    tempInput.__ID = this.__TVInputs.length;
                    tempInput.__InputService = this.__accessory.addService(Service.InputSource, tempInputName, (this.__TVInputs.length + 1));
                    tempInput.__uri = TVTuner.source;
                    tempInput.__InputService.getCharacteristic(Characteristic.ConfiguredName).updateValue(tempInputName);
                    tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.TUNER);
                    tempInput.__InputService.getCharacteristic(Characteristic.IsConfigured).updateValue(Characteristic.IsConfigured.CONFIGURED);
                    tempInput.__InputService.getCharacteristic(Characteristic.CurrentVisibilityState).updateValue(Characteristic.CurrentVisibilityState.SHOWN);
                    tempInput.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).updateValue(Characteristic.CurrentVisibilityState.SHOWN);
                    tempInput.__InputService.getCharacteristic(Characteristic.Identifier).updateValue(tempInput.__ID);
                    tempInput.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).on('set', this.hideShowTVInputs.bind(tempInput));
                    tempInput.__InputService.getCharacteristic(Characteristic.ConfiguredName).on('set', this.setTVInputName.bind(tempInput));
                    this.__TVService.addLinkedService(tempInput.__InputService);
                    this.__TVInputs.push(tempInput);  // add to array of inputs

                    // For each discovered tuner, include channels as inputs in HomeKit
                    // Seems if there are alot of channels, does slow down interacting with the accesssory settings intially in HomeKit
                    // Todo
                    // -- Maybe put suffix or prefix to channel name to show which input attached ie: digital, cable, satellite etc
                    if (includeChannels == true) {
                        var response = request("POST", "http://" + this.__IPAddress + "/sony/avContent", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getContentList", "id": 2, "params": [{"source": TVTuner.source, "stIx": 0}], "version": "1.2"} });
                        if (response.statusCode == 200 && JSON.parse(response.body).result[0]) {
                            var tempChannelList = JSON.parse(response.body).result[0];
                            JSON.parse(response.body).result[0].forEach(TVChannel => {

                                //TVChannel.programMediaType == "tv";
                                //TVChannel.programMediaType == "radio";

                                var tempInput = new InputClass();
                                tempInput.__ID = this.__TVInputs.length;
                                tempInput.__InputService = this.__accessory.addService(Service.InputSource, TVChannel.title, (this.__TVInputs.length + 1));
                                tempInput.__uri = TVChannel.uri;
                                tempInput.__InputService.getCharacteristic(Characteristic.ConfiguredName).updateValue(TVChannel.title);
                                tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.OTHER); // Maybe Characteristic.InputSourceType.APPLICATION??
                                tempInput.__InputService.getCharacteristic(Characteristic.IsConfigured).updateValue(Characteristic.IsConfigured.CONFIGURED);
                                tempInput.__InputService.getCharacteristic(Characteristic.CurrentVisibilityState).updateValue(Characteristic.CurrentVisibilityState.SHOWN);
                                tempInput.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).updateValue(Characteristic.CurrentVisibilityState.SHOWN);
                                tempInput.__InputService.getCharacteristic(Characteristic.Identifier).updateValue(tempInput.__ID);
                                tempInput.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).on('set', this.hideShowTVInputs.bind(tempInput));
                                tempInput.__InputService.getCharacteristic(Characteristic.ConfiguredName).on('set', this.setTVInputName.bind(tempInput));
                                this.__TVService.addLinkedService(tempInput.__InputService);
                                this.__TVInputs.push(tempInput);  // add to array of inputs
                            });
                        }
                    }
                } else {
                    // TV tuner type we dont know about
                    console.log("DEBUG: TV tuner of type", TVTuner.source.toUpperCase());
                }
            });
        }

        // Build application list
        // Seems if there are alot of channels, does slow down interacting with the accesssory settings intially in HomeKit
        // Todo
        // -- Maybe put suffix or prefix to application name to show input as application??
        if (includeApplications == true) {
            var response = request("POST", "http://" + this.__IPAddress + "/sony/appControl", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getApplicationList", "id": 60, "params": [""], "version": "1.0"} });
            if (response.statusCode == 200 && JSON.parse(response.body).result[0]) {
                JSON.parse(response.body).result[0].forEach(TVApplication => {
                    var tempInput = new InputClass();
                    tempInput.__ID = this.__TVInputs.length;
                    tempInput.__InputService = this.__accessory.addService(Service.InputSource, TVApplication.title, (this.__TVInputs.length + 1));
                    tempInput.__uri = TVApplication.uri;
                    tempInput.__InputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.APPLICATION);
                    tempInput.__InputService.getCharacteristic(Characteristic.IsConfigured).updateValue(Characteristic.IsConfigured.CONFIGURED);
                    tempInput.__InputService.getCharacteristic(Characteristic.CurrentVisibilityState).updateValue(Characteristic.CurrentVisibilityState.SHOWN);
                    tempInput.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).updateValue(Characteristic.CurrentVisibilityState.SHOWN);
                    tempInput.__InputService.getCharacteristic(Characteristic.Identifier).updateValue(tempInput.__ID);
                    tempInput.__InputService.getCharacteristic(Characteristic.TargetVisibilityState).on('set', this.hideShowTVInputs.bind(tempInput));
                    this.__TVService.addLinkedService(tempInput.__InputService);
                    this.__TVInputs.push(tempInput);  // add to array of inputs
                });
            }
        }     
    },

    __updateHomeKit: function(triggerTimeout) {
        const scale = (num, in_min, in_max, out_min, out_max) => {
            if (num > in_max) num = in_max;
            if (num < in_min) num = in_min;
            return (num - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
        }

        if (this.__updatingHomeKit == false) {
            axios.all([
                axios.post("http://" + this.__IPAddress + "/sony/system", {"method": "getPowerStatus", "id": 50, "params": [""],  "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}}),
                axios.post("http://" + this.__IPAddress + "/sony/avContent", {"method": "getPlayingContentInfo", "id": 103, "params": [""],  "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}}),
                axios.post("http://" + this.__IPAddress + "/sony/audio", {"method": "getVolumeInformation", "id": 33, "params": [""],  "version": "1.0"} , {headers: {"X-Auth-PSK": SonyTVPSK}}),
                axios.post("http://" + this.__IPAddress + "/sony/system", {"method": "getSystemInformation", "id": 33, "params": [""], "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}}),
                axios.post("http://" + this.__IPAddress + "/sony/avContent", {"method": "getCurrentExternalInputsStatus", "id": 105, "params": [""], "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}}),
            ])
            .then(axios.spread(function (power, activeinput, volume, firmware, inputnames) {
                if (power.status == 200 && power.data.result) {
                    // Update power status
                    if (this.__cachedPowerState == null ) {
                        this.__TVService.getCharacteristic(Characteristic.Active).updateValue(power.data.result[0].status.toUpperCase() == "ACTIVE" ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
                    }
                    else {
                        this.__TVService.getCharacteristic(Characteristic.Active).updateValue(this.__cachedPowerState);
                    }

                    if ((power.data.result[0].status.toUpperCase() == "ACTIVE" || this.__cachedPowerState == Characteristic.Active.ACTIVE) && this.__waitSetInput != null)  {
                        // TVs been switched on externally to HomeKit and we have an "cached input value. We'll clear the cached value in this case and let the loop below update the current state
                        this.__waitSetInput = null;
                    }
                }
                if (activeinput.status == 200 && activeinput.data.result) {
                    // Update active input
                    this.__TVInputs.forEach(TVInput => {
                        // search through the input list to work out which input is selected
                        if ((activeinput.data.result[0].uri == TVInput.__uri) || (activeinput.data.result[0].source.substr(0,3).toUpperCase() == "TV:" && activeinput.data.result[0].source == TVInput.__uri)) {
                            this.__TVService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(TVInput.__ID);
                        }
                    });
                } else if (this.__waitSetInput != null) {
                    // since we got an error requesting inputs, we assume TV is off.. So if we have an input waiting to be set with the physcial TV, update that to reflect in HomeKit
                    this.__TVService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(this.__waitSetInput);
                }
                if (volume.status == 200 && volume.data.result) {
                    // Update volume information
                    volume.data.result[0].forEach(VolumeInfo => {
                        if (VolumeInfo.target.toUpperCase() == "SPEAKER")
                        {
                            // Scale volume
                            this.__SpeakerService.getCharacteristic(Characteristic.Volume).updateValue(scale(VolumeInfo.volume, VolumeInfo.minVolume, VolumeInfo.maxVolume, 0, 100));
                            this.__SpeakerService.getCharacteristic(Characteristic.Mute).updateValue(VolumeInfo.mute);
                        }
                    });
                }
                if (firmware.status == 200 && firmware.data.result) {
                    // Update firmware version
                    this.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, firmware.data.result[0].generation);
                }
                if (inputnames.status == 200 && inputnames.data.result) {
                    // TODO - update inout names
                }
            }.bind(this)))
            .finally(() => {
                if (triggerTimeout == true) {
                    setTimeout(this.__updateHomeKit.bind(this, true), this.__refreshTimeout); 
                }
            })
            .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));
        } else {
            if (triggerTimeout == true) {
                setTimeout(this.__updateHomeKit.bind(this, true), this.__refreshTimeout); 
            }
        }
    }
}

var response = request("POST", "http://" + SonyTVIP + "/sony/system", {headers: {"X-Auth-PSK": SonyTVPSK}, json: {"method": "getSystemInformation", "id": 33, "params": [""], "version": "1.0"} });
if (response.statusCode == 200 && JSON.parse(response.body).result) {
    var SonyTVSystemInfo = JSON.parse(response.body).result[0];
    var SonyTV = new SonyTVClass();
    SonyTV.__accessory = exports.accessory = new Accessory("Sony " + SonyTVSystemInfo.model, uuid.generate("hap-nodejs:accessories:sony_" + SonyTVSystemInfo.serial));
    SonyTV.__accessory.username = SonyTVSystemInfo.macAddr; // We'll use the TVs mac address for the HomeKit one
    SonyTV.__accessory.username ="777777998877";

    SonyTV.__accessory.pincode = AccessoryPincode;
    SonyTV.__accessory.category = Accessory.Categories.TELEVISION;  // Television type acessory
    SonyTV.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, "Sony");
    SonyTV.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, SonyTVSystemInfo.model);
    SonyTV.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, SonyTVSystemInfo.serial);
    SonyTV.__accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, SonyTVSystemInfo.generation);

    SonyTV.__IPAddress = SonyTVIP;  // Store IP address of the TV for later calls
    SonyTV.addTelevison(SonyTV.__accessory, "Sony " + SonyTVSystemInfo.model, 1);
    SonyTV.refreshHomeKit(2000);    // Refresh HomeKit every 2 seconds
}