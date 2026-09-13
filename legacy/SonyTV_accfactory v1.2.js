// HAP-NodeJS accessory for Sony Brava TVs
// 
// https://pro-bravia.sony.net/develop/
//
// todo
// -- Mutiple PSKs??
// -- Dynamic removal/addition of inputs into HomeKit
// -- Remote play/pause functionality
// -- Update input names during status updates
// -- Prefix or suffix to input channel/application names
// -- dymanically add new devices
//
// done
// -- switched to axios library
// -- discover all TVs using UDP on the local network and create accessories for each one
// -- Update firmware version during status updates
// -- Bug fix: getting speaker volume/mute status
// -- Build list of applications on TV as HomeKit inputs
// -- Small fix for HAPNodeJS => v9.5
// -- accessories are advertised using "ciao" backend for hap-nodejs
//
// Version 30/11/2022
// Mark Hulskamp

module.exports = accessories = [];

"use strict";

// Define HAP-NodeJS requirements
var HAPNodeJS = require("hap-nodejs");
var Accessory = HAPNodeJS.Accessory; 
var Service = HAPNodeJS.Service;
var Characteristic = HAPNodeJS.Characteristic;
var uuid = HAPNodeJS.uuid;

// Define external lbrary requirements
var axios = require("axios");

// Define nodejs module requirements
var dgram = require('dgram');   // for UDP

// Defines for the accessory
const AccessoryName =  "Television";                    // name of accessory
const AccessoryPincode = "031-45-154";                  // pin code for paring  

const SonyTVPSK = "0000";                               // PSK key

const DISCOVERTIMEOUT = 5000;                           // delay to process disovery requests
const TVTURNONDELAY = 2000;

// Define some extra remote commands with aren't in the HAP spec
Characteristic.RemoteKey.SETTINGS = 101;
Characteristic.RemoteKey.PLAY = 102;
Characteristic.RemoteKey.PAUSE = 102;
Characteristic.RemoteKey.HOME = 103;


// TV inputs class
class Input {
    constructor() {
        this.inputID = null;
        this.inputService = null;
        this.uri = null;
    }
}

// Sony TV device class
class SonyTV {
    constructor(HomeKitAccessory, IPAddress) {
        this.HomeKitAccessory = HomeKitAccessory;   // HomeKit accessory
        this.IPAddress = IPAddress;                 // IP Address of TV
        this.TVService = null;                      // HomeKit service for the TV
        this.speakerService = null;                 // HomeKit service for the TV speaker
        this.remoteCommands = [];                   // array of remote commands for this TV
        this.TVInputs = [];                         // array of input objects for things such as TV inputs, tuners and/or channels
        this.updatingHomeKit = false;               // flags if we're updating HomeKit status or not
        this.cachedPowerState = null;               // cached status of TV power ie: on/off
        this.waitSetInput = null;                   // flags if we have HomeKit waiting to set an input when TV was off
    }      


    async addTelevison(thisServiceName) {
        this.TVService = this.HomeKitAccessory.addService(Service.Television, thisServiceName, 1);
        this.TVService.setCharacteristic(Characteristic.ConfiguredName, thisServiceName);
        this.TVService.setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
        this.HomeKitAccessory.setPrimaryService(this.TVService);

        // Add the TV speaker as a service
        this.speakerService = this.HomeKitAccessory.addService(Service.TelevisionSpeaker);
        this.speakerService.setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.ABSOLUTE);

        //Television.addCharacteristic(Characteristic.PictureMode);
        // Setup call backs
        this.TVService.getCharacteristic(Characteristic.Active).on('set', this.setPowerState.bind(this));
        this.TVService.getCharacteristic(Characteristic.ActiveIdentifier).on('set', this.setActiveInput.bind(this));
        this.TVService.getCharacteristic(Characteristic.RemoteKey).on('set', this.sendRemoteKey.bind(this));
        this.speakerService.getCharacteristic(Characteristic.VolumeSelector).on('set', this.setVolume.bind(this));
        this.TVService.getCharacteristic(Characteristic.PowerModeSelection).on('set', this.accessTVSettings.bind(this));

        // Build list of inputs for both physical and applicaions        
        await this.#buildRemoteCmdList();
        await this.#buildInputList();
        //await this.#buildChannelList(;
        //await this.#buildApplicationList();

        this.#updateHomeKit();  // Do initial update of HomeKit
        console.log("Setup Sony Television '%s' on '%s'", thisServiceName, this.HomeKitAccessory.username);
    }

    setPowerState(value, callback) {
        this.updatingHomeKit = true;
        this.cachedPowerState = null;
        
        // Turns on/off the TV
        axios.post("http://" + this.IPAddress + "/sony/system", {"method": "setPowerStatus", "id": 55, "params": [{"status": (value == Characteristic.Active.ACTIVE) ? true : false}], "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}})
        .then(response => {
            if (response.status = 200) {
                // Reflect active state for the speaker service also
                if (this.speakerService != null) {
                    this.speakerService.getCharacteristic(Characteristic.Active).updateValue(value);
                }

                // See if we have a cached input to set if status is power on
                if (this.waitSetInput != null && state == Characteristic.Active.ACTIVE) {
                    this.TVService.getCharacteristic(Characteristic.ActiveIdentifier).setValue(this.waitSetInput);
                    this.waitSetInput = null;
                }
            }
        })
        .finally(() => {
            this.cachedPowerState = value;    // Cache the power state we set for update loop.. Allows updated HomeKit status correctly as TV takes a few seconds to return its turn power state if queried
            setTimeout(function() {
                this.cachedPowerState = null;
            }.bind(this), TVTURNONDELAY);

            callback(); // set power state
            this.updatingHomeKit = false;
        })
        .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));
    }

    setActiveInput(value, callback) {
        this.updatingHomeKit = true;

        // Switches inputs on the TV
        this.TVInputs.forEach(TVInput => {
            // search thru the input list to work out which input is to be selected
            if (value == TVInput.inputID) {
                axios.post("http://" + this.IPAddress + "/sony/avContent", {"method": "setPlayContent", "id": 13, "params": [{"uri": TVInput.uri}],  "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}})
                .then(response => {
                    if (response.status != 200 || response.data.error) {
                        // REST API post failed, so cache value we wanted to set
                        this.waitSetInput = value;
                    }
                })
                .finally(() => {
                    callback(); // set input
                    this.updatingHomeKit = false;
                })
                .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));
            }
        });
    }

    sendRemoteKey(value, callback) {
        // TODO - handle special case on play/puase which HomeKit sends, rather than seperate Play and pause commands Sony accepts
        if (this.remoteCommands[value] && this.remoteCommands[value] != "") {
            // send remote command
            var IRCCBodyRequest = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>' + this.remoteCommands[value] + '</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>';
            axios.post("http://" + this.IPAddress + "/sony/IRCC", IRCCBodyRequest, {headers: {"X-Auth-PSK": SonyTVPSK, "Content-Type": "text/xml", "soapaction": '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"'}})
            .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));
        }
        if (typeof callback === 'function') callback();  // do callback if defined
    }

    setVolume(value, callback) {
        this.updatingHomeKit = true;
        axios.post("http://" + this.IPAddress + "/sony/audio", {"method": "setAudioVolume", "id": 601, "params": [{"target": "speaker", "volume": (value == Characteristic.VolumeSelector.INCREMENT ? "+1" : "-1")}],  "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}})
        .finally(() => {
            callback(); // set volume
            this.updatingHomeKit = false;
        })
        .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));
    }

    accessTVSettings(value, callback) {
        if (value == Characteristic.PowerModeSelection.SHOW && this.remoteCommands[Characteristic.RemoteKey.SETTINGS] && this.remoteCommands[Characteristic.RemoteKey.SETTINGS] != "") {
            this.sendRemoteKey(Characteristic.RemoteKey.SETTINGS, null);
        }
        callback(); // accessed TV settings
    }

    setTVInputName(value, callback) {  
        this.updatingHomeKit = true; 
        
        // Update TV inputs name in HomeKit
        this.inputService.getCharacteristic(Characteristic.ConfiguredName).updateValue(value);
        callback();
        this.updatingHomeKit = false;
    }

    hideShowTVInputs(value, callback) {
        this.updatingHomeKit = true;

        // Allow enabling/disabling input section in homekit
        this.inputService.getCharacteristic(Characteristic.CurrentVisibilityState).updateValue(value);
        this.inputService.getCharacteristic(Characteristic.TargetVisibilityState).updateValue(value);

        // See if we can mirror the hide/show status of an input directly on the TV??
        callback();
        this.updatingHomeKit = false;
    }

    refreshHomeKit(refreshTimeMS) {
        // setup status check interval as defined
        setInterval(this.#updateHomeKit.bind(this), refreshTimeMS);
        console.log("HomeKit refresh for '%s' set for every '%s'ms", AccessoryName, refreshTimeMS);
    }

    async #buildRemoteCmdList() {
        // Create mapping of available remote commands so we can use in HomeKit remote app
        await axios.post("http://" + this.IPAddress + "/sony/system", {"method": "getRemoteControllerInfo", "id": 1, "params": [""],  "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}})
        .then(response => {
            if (response.status == 200 && response.data.result) {
                this.remoteCommands = [];
                response.data.result[1].forEach(remoteCommand => {
                    switch (remoteCommand.name.toUpperCase()) {
                        case "REWIND" :
                        {
                            this.remoteCommands[Characteristic.RemoteKey.REWIND] = remoteCommand.value;
                            break;
                        }

                        case "FORWARD" :
                        {
                            this.remoteCommands[Characteristic.RemoteKey.FAST_FORWARD] = remoteCommand.value;
                            break;
                        }

                        case "NEXT" :
                        {
                            this.remoteCommands[Characteristic.RemoteKey.NEXT_TRACK] = remoteCommand.value;
                            break;
                        }

                        case "PREV" :
                        {
                            this.remoteCommands[Characteristic.RemoteKey.PREVIOUS_TRACK] = remoteCommand.value;
                            break;
                        }

                        case "UP" :
                        {
                            this.remoteCommands[Characteristic.RemoteKey.ARROW_UP] = remoteCommand.value;
                            break;
                        }

                        case "DOWN" :
                        {
                            this.remoteCommands[Characteristic.RemoteKey.ARROW_DOWN] = remoteCommand.value;
                            break;
                        }

                        case "LEFT" :
                        {
                            this.remoteCommands[Characteristic.RemoteKey.ARROW_LEFT] = remoteCommand.value;
                            break;
                        }

                        case "RIGHT" :
                        {
                            this.remoteCommands[Characteristic.RemoteKey.ARROW_RIGHT] = remoteCommand.value;
                            break;
                        }

                        case "CONFIRM" :
                        {
                            this.remoteCommands[Characteristic.RemoteKey.SELECT] = remoteCommand.value;
                            break;
                        }

                        case "RETURN" :
                        {
                            this.remoteCommands[Characteristic.RemoteKey.BACK] = remoteCommand.value;
                            break;
                        }

                        case "EXIT" :
                        {
                            this.remoteCommands[Characteristic.RemoteKey.EXIT] = remoteCommand.value;
                            break;
                        }

                        case "PLAY" : {
                            //Characteristic.RemoteKey.PLAY_PAUSE
                            this.remoteCommands[Characteristic.RemoteKey.PLAY] = remoteCommand.value;
                            break;
                        }

                        case "PAUSE" :
                        {
                            //Characteristic.RemoteKey.PLAY_PAUSE
                            this.remoteCommands[Characteristic.RemoteKey.PAUSE] = remoteCommand.value;
                            break;
                        }

                        case "DISPLAY" :
                        {
                            this.remoteCommands[Characteristic.RemoteKey.INFORMATION] = remoteCommand.value;
                            break;
                        }

                        case "ACTIONMENU" :
                        {
                            this.remoteCommands[Characteristic.RemoteKey.SETTINGS] = remoteCommand.value;
                            break;
                        }

                        case "HOME" :
                        {
                            this.remoteCommands[Characteristic.RemoteKey.HOME] = remoteCommand.value;
                            break;
                        }
                    }
                });
            }
        })
        .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));
    }

    async #buildInputList() {
        // Build and setup HomeKit objects for the available inputs on the TV
        this.updatingHomeKit = true;
        await axios.all([
            axios.post("http://" + this.IPAddress + "/sony/avContent", {"method": "getCurrentExternalInputsStatus", "id": 105, "params": [""], "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}}),
            axios.post("http://" + this.IPAddress + "/sony/avContent", {"method": "getSourceList", "id": 1, "params": [{"scheme": "tv"}], "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}})     
        ])
        .then(axios.spread(function (inputlist, tunerlist) {
            if (inputlist.status == 200 && inputlist.data.result) {
                inputlist.data.result[0].forEach(TVInput => {
                    var index = (this.TVInputs.push(new Input()) - 1);  // add to array of inputs
                    this.TVInputs[index].inputID = (index + 1);
                    this.TVInputs[index].inputService = this.HomeKitAccessory.addService(Service.InputSource, TVInput.title, this.TVInputs[index].inputID);
                    this.TVInputs[index].uri = TVInput.uri;
                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.ConfiguredName).updateValue(((TVInput.label == "") ? TVInput.title : TVInput.title + " (" + TVInput.label + ")"));
                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.IsConfigured).updateValue(Characteristic.IsConfigured.CONFIGURED);
                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.CurrentVisibilityState).updateValue(Characteristic.CurrentVisibilityState.SHOWN);
                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.TargetVisibilityState).updateValue(Characteristic.CurrentVisibilityState.SHOWN);    
                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.Identifier).updateValue(this.TVInputs[index].inputID);

                    // Determine the input type by the "icon" tag. Split after the "meta:" entry for the type
                    switch(TVInput.icon.split(":")[1].toUpperCase())
                    {
                        case "HDMI" :
                        {
                            this.TVInputs[index].inputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.HDMI);
                            break
                        }

                        case "COMPONENT" :
                        case "COMPONENTD" :
                        {
                            this.TVInputs[index].inputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.COMPONENT_VIDEO);
                            break
                        }

                        case "COMPOSITE" :
                        {
                            this.TVInputs[index].inputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.COMPOSITE_VIDEO);
                            break
                        }

                        case "SVIDEO" :
                        {
                            this.TVInputs[index].inputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.S_VIDEO);
                            break
                        }

                        case "WIFIDISPLAY" :
                        {
                            this.TVInputs[index].inputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.AIRPLAY);
                            break
                        }

                        case "TUNERDEVICE" :
                        case "TV" :
                        case "TUNER" :
                        {
                            this.TVInputs[index].inputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.TUNER);
                            break
                        }

                        default : 
                        {
                            this.TVInputs[index].inputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.OTHER);
                            console.log("DEBUG: Got a input type we dont handle", TVInput.icon.split(":")[1].toUpperCase());
                            break;
                        }
                    }
                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.TargetVisibilityState).on('set', this.hideShowTVInputs.bind(this.TVInputs[index]));
                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.ConfiguredName).on('set', this.setTVInputName.bind(this.TVInputs[index]));
                    this.TVService.addLinkedService(this.TVInputs[index].inputService);
                });
            }

            if (tunerlist.status == 200 && tunerlist.data.result) {
                tunerlist.data.result[0].forEach(TVTuner => {
                    if (TVTuner.source.toUpperCase().substr(0,3) == "TV:") {
                        var tempInputName = "";
                        if (TVTuner.source.toUpperCase() == "TV:DVBT") tempInputName = "Digital Tuner";
                        if (TVTuner.source.toUpperCase() == "TV:ANALOG") tempInputName = "Analog Tuner";
                        if (TVTuner.source.toUpperCase() == "TV:DVBC") tempInputName = "Cable Tuner";
                        if (TVTuner.source.toUpperCase() == "TV:DVBS") tempInputName = "Satellite Tuner";
                        if (tempInputName != "") {
                            var index = (this.TVInputs.push(new Input()) - 1);  // add to array of inputs
                            this.TVInputs[index].inputID = (index + 1);
                            this.TVInputs[index].inputService = this.HomeKitAccessory.addService(Service.InputSource, tempInputName, this.TVInputs[index].inputID);
                            this.TVInputs[index].uri = TVTuner.source;
                            this.TVInputs[index].inputService.getCharacteristic(Characteristic.ConfiguredName).updateValue(tempInputName);
                            //this.TVInputs[index].inputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.TV);  // Not defined yet??
                            this.TVInputs[index].inputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.TUNER);
                            this.TVInputs[index].inputService.getCharacteristic(Characteristic.IsConfigured).updateValue(Characteristic.IsConfigured.CONFIGURED);
                            this.TVInputs[index].inputService.getCharacteristic(Characteristic.CurrentVisibilityState).updateValue(Characteristic.CurrentVisibilityState.SHOWN);
                            this.TVInputs[index].inputService.getCharacteristic(Characteristic.TargetVisibilityState).updateValue(Characteristic.CurrentVisibilityState.SHOWN);
                            this.TVInputs[index].inputService.getCharacteristic(Characteristic.Identifier).updateValue(this.TVInputs[index].inputID);
                            this.TVInputs[index].inputService.getCharacteristic(Characteristic.TargetVisibilityState).on('set', this.hideShowTVInputs.bind(this.TVInputs[index]));
                            this.TVInputs[index].inputService.getCharacteristic(Characteristic.ConfiguredName).on('set', this.setTVInputName.bind(this.TVInputs[index]));
                            this.TVService.addLinkedService(this.TVInputs[index].inputService);
                        }
                    } else {
                        // TV tuner type we dont know about
                        console.log("DEBUG: TV tuner of type", TVTuner.source.toUpperCase());
                    }
                });
            }
        }.bind(this)))
        .finally(() => {
            this.updatingHomeKit = false;
        })
        .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));  
    }

    async #buildChannelList() {
        this.updatingHomeKit = true;
        await axios.post("http://" + this.IPAddress + "/sony/avContent", {"method": "getSourceList", "id": 1, "params": [{"scheme": "tv"}], "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}})
        .then(response => {
            if (response.status == 200 && response.data.result) {
                response.data.result[0].forEach(TVTuner => {
                    if (TVTuner.source.toUpperCase().substr(0,3) == "TV:") {
                        // For each discovered tuner, include channels as inputs in HomeKit
                        // Seems if there are alot of channels, does slow down interacting with the accesssory settings intially in HomeKit
                        // Todo
                        // -- Maybe put suffix or prefix to channel name to show which input attached ie: digital, cable, satellite etc
                        axios.post("http://" + this.IPAddress + "/sony/avContent", {"method": "getContentList", "id": 2, "params": [{"source": TVTuner.source, "stIx": 0}], "version": "1.2"}, {headers: {"X-Auth-PSK": SonyTVPSK}})
                        .then(response => {
                            if (response.status == 200 && response.data.result) {
                                response.data.result[0].forEach(TVChannel => {

                                    //TVChannel.programMediaType == "tv";
                                    //TVChannel.programMediaType == "radio";

                                    var index = (this.TVInputs.push(new Input()) - 1);  // add to array of inputs
                                    this.TVInputs[index].inputID = (index + 1);
                                    this.TVInputs[index].inputService = this.HomeKitAccessory.addService(Service.InputSource, TVChannel.title, this.TVInputs[index].inputID);
                                    this.TVInputs[index].uri = TVChannel.uri;
                                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.ConfiguredName).updateValue(TVChannel.title);
                                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.OTHER); // Maybe Characteristic.InputSourceType.APPLICATION??
                                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.IsConfigured).updateValue(Characteristic.IsConfigured.CONFIGURED);
                                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.CurrentVisibilityState).updateValue(Characteristic.CurrentVisibilityState.SHOWN);
                                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.TargetVisibilityState).updateValue(Characteristic.CurrentVisibilityState.SHOWN);
                                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.Identifier).updateValue(this.TVInputs[index].inputID);
                                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.TargetVisibilityState).on('set', this.hideShowTVInputs.bind(this.TVInputs[index]));
                                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.ConfiguredName).on('set', this.setTVInputName.bind(this.TVInputs[index]));
                                    this.TVService.addLinkedService(this.TVInputs[index].inputService);
                                });
                            }
                        })
                    }
                });
            }
        })
        .finally(() => {
            this.updatingHomeKit = false;
        })
        .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));  
    }

    async #buildApplicationList() {
        // Seems if there are alot of applications, does slow down interacting with the accesssory settings intially in HomeKit
        // Todo
        // -- Maybe put suffix or prefix to application name to show input as application??
        this.updatingHomeKit = true;
        await axios.post("http://" + this.IPAddress + "/sony/appControl", {"method": "getApplicationList", "id": 60, "params": [""], "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}})
        .then(response => {
            if (response.status = 200 && response.data.result) {
                response.data.result[0].forEach(TVApplication => {
                    var index = (this.TVInputs.push(new Input()) - 1);  // add to array of inputs
                    this.TVInputs[index].inputID = (index + 1);
                    this.TVInputs[index].inputService = this.HomeKitAccessory.addService(Service.InputSource, TVApplication.title, this.TVInputs[index].inputID);
                    this.TVInputs[index].uri = TVApplication.uri;
                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.InputSourceType).updateValue(Characteristic.InputSourceType.APPLICATION);
                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.IsConfigured).updateValue(Characteristic.IsConfigured.CONFIGURED);
                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.CurrentVisibilityState).updateValue(Characteristic.CurrentVisibilityState.SHOWN);
                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.TargetVisibilityState).updateValue(Characteristic.CurrentVisibilityState.SHOWN);
                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.Identifier).updateValue(this.TVInputs[index].inputID);
                    this.TVInputs[index].inputService.getCharacteristic(Characteristic.TargetVisibilityState).on('set', this.hideShowTVInputs.bind(this.TVInputs[index].inputID));
                    this.TVService.addLinkedService(this.TVInputs[index].inputService);
                });
            }
        }) 
        .finally(() => {
            this.updatingHomeKit = false;
        })
        .catch(error => console.log("DEBUG: " + arguments.callee.name, AccessoryName, error.message));  
    }

    #updateHomeKit() {
        if (this.updatingHomeKit == false) {
            axios.all([
                axios.post("http://" + this.IPAddress + "/sony/system", {"method": "getPowerStatus", "id": 50, "params": [""],  "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}}),
                axios.post("http://" + this.IPAddress + "/sony/avContent", {"method": "getPlayingContentInfo", "id": 103, "params": [""],  "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}}),
                axios.post("http://" + this.IPAddress + "/sony/audio", {"method": "getVolumeInformation", "id": 33, "params": [""],  "version": "1.0"} , {headers: {"X-Auth-PSK": SonyTVPSK}}),
                axios.post("http://" + this.IPAddress + "/sony/system", {"method": "getSystemInformation", "id": 33, "params": [""], "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}}),
                axios.post("http://" + this.IPAddress + "/sony/avContent", {"method": "getCurrentExternalInputsStatus", "id": 105, "params": [""], "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}}),
            ])
            .then(axios.spread(function (power, activeinput, volume, firmware, inputnames) {
                if (power.status == 200 && power.data.result) {
                    // Update power status
                    if (this.cachedPowerState == null ) {
                        this.TVService.getCharacteristic(Characteristic.Active).updateValue(power.data.result[0].status.toUpperCase() == "ACTIVE" ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
                    }
                    else {
                        this.TVService.getCharacteristic(Characteristic.Active).updateValue(this.__cachedPowerState);
                    }

                    if ((power.data.result[0].status.toUpperCase() == "ACTIVE" || this.cachedPowerState == Characteristic.Active.ACTIVE) && this.waitSetInput != null)  {
                        // TVs been switched on externally to HomeKit and we have an "cached input value. We'll clear the cached value in this case and let the loop below update the current state
                        this.waitSetInput = null;
                    }
                }
                if (activeinput.status == 200 && activeinput.data.result) {
                    // Update active input
                    this.TVInputs.forEach(TVInput => {
                        // search through the input list to work out which input is selected
                        if ((activeinput.data.result[0].uri == TVInput.uri) || (activeinput.data.result[0].source.substr(0,3).toUpperCase() == "TV:" && activeinput.data.result[0].source == TVInput.uri)) {
                            this.TVService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(TVInput.inputID);
                        }
                    });
                } else if (this.waitSetInput != null) {
                    // since we got an error requesting inputs, we assume TV is off.. So if we have an input waiting to be set with the physcial TV, update that to reflect in HomeKit
                    this.TVService.getCharacteristic(Characteristic.ActiveIdentifier).updateValue(this.waitSetInput);
                }
                if (volume.status == 200 && volume.data.result) {
                    // Update volume information
                    volume.data.result[0].forEach(VolumeInfo => {
                        if (VolumeInfo.target.toUpperCase() == "SPEAKER")
                        {
                            // Scale volume
                            this.speakerService.getCharacteristic(Characteristic.Volume).updateValue(this.#scale(VolumeInfo.volume, VolumeInfo.minVolume, VolumeInfo.maxVolume, 0, 100));
                            this.speakerService.getCharacteristic(Characteristic.Mute).updateValue(VolumeInfo.mute);
                        }
                    });
                }
                if (firmware.status == 200 && firmware.data.result) {
                    // Update firmware version
                    this.HomeKitAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, firmware.data.result[0].generation);
                }
                if (inputnames.status == 200 && inputnames.data.result) {
                    // TODO - update input names
                }
            }.bind(this)))
            .finally(() => {
            })
            .catch(() => {
            });
        }
    }

    #scale(num, in_min, in_max, out_min, out_max) {
        // Scales a number between range 1, to range 2
        if (num > in_max) num = in_max;
        if (num < in_min) num = in_min;
        return ((num - in_min) * (out_max - out_min) / (in_max - in_min)) + out_min;
    }
}

// General functions
function doDiscovery(callback) {
    var foundDevices = [];
    var udpSocket = dgram.createSocket({type:"udp4", reuseAddr:true});

    udpSocket.bind(0, "0.0.0.0", function () {
        udpSocket.addMembership('224.0.0.1');
        udpSocket.setBroadcast(true);
    });

    udpSocket.on('message', function (chunk, info) {
        // Callback triggered when we've received a UDP response
        var ssdpURL = new URL(chunk.toString().split("LOCATION: ")[1].split("\r\n")[0]);
        if (foundDevices.some(ip => ip.IPAddress === ssdpURL.hostname.split(":")[0]) == false) {
            // Have not found this device before, so add to array of discovered systems
            foundDevices.push({IPAddress: ssdpURL.hostname.split(":")[0], ssdpURL: ssdpURL.href});
         }
    });

    udpSocket.on('listening', function() {
        // UDP socket opened to listen, so send the queries
        var udpQuery1 = 
        "M-SEARCH * HTTP/1.1\r\n" +
        "HOST:239.255.255.250:1900\r\n" +
        "MAN:\"ssdp:discover\"\r\n" +
        "ST:urn:schemas-sony-com:service:ScalarWebAPI:1\r\n" + 
        "MX:2\r\n" +
        "\r\n";

        udpSocket.send(udpQuery1, 0, udpQuery1.length, 1900, "239.255.255.250");

        // Sent the discovery messages, so wait for replies 
        setTimeout(function () {
            udpSocket.close();
            callback(foundDevices);
        }, DISCOVERTIMEOUT);
    });
}

function processDeviceforHomeKit(device) {
    axios.post("http://" + device.IPAddress + "/sony/system", {"method": "getSystemInformation", "id": 33, "params": [""], "version": "1.0"}, {headers: {"X-Auth-PSK": SonyTVPSK}})
    .then(response => {
        if (response.status == 200 && response.data.result) {
  
            var tempName = "Sony " + response.data.result[0].model;
            var tempAccessory = exports.accessory = new Accessory(tempName, uuid.generate("hap-nodejs:accessories:sony_" + response.data.result[0].serial));
            tempAccessory.username = response.data.result[0].macAddr.toUpperCase();
            tempAccessory.pincode = AccessoryPincode;
            tempAccessory.category = Accessory.Categories.TELEVISION;  // Television type acessory
            tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, "Sony");
            tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, response.data.result[0].model);
            tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, response.data.result[0].serial);
            tempAccessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, response.data.result[0].generation);
        
            var tempDevice = new SonyTV(tempAccessory, device.IPAddress); // Create the TV class
            tempDevice.addTelevison(tempName)
            .then(() => {
                tempDevice.refreshHomeKit(2000);  // Refresh HomeKit every 2 seconds after inital updates

                accessories.push(tempAccessory);   // Push onto export array for HAP-NodeJS "accessory factory"
                tempAccessory.publish({username: tempAccessory.username, pincode: tempAccessory.pincode, category: tempAccessory.category, advertiser: "ciao"});    // Publish accessory on local network
            });
        }
    })
    .catch(error => console.log("DEBUG: failed to process device into HomeKit", device));
}


// Startup code
doDiscovery(function(devices) {
    devices && devices.forEach(device => {
        processDeviceforHomeKit(device);
    });
});