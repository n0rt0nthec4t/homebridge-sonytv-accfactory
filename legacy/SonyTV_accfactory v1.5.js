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
//
// done
// -- switched to axios library
// -- discover all TVs using UDP on the local network and create accessories for each one
// -- Update firmware version during status updates
// -- Bug fix: getting speaker volume/mute status
// -- Build list of applications on TV as HomeKit inputs
// -- Small fix for HAP => v9.5
// -- accessories are advertised using "ciao" backend for hap-nodejs
// -- dymanically add new devices
//
// Code version 22/2/2024
// Mark Hulskamp

module.exports = accessories = [];

"use strict";

// Define HAP-NodeJS requirements
var HAP = require("hap-nodejs");

// Define external library requirements
var axios = require("axios");

// Define nodejs module requirements
var util = require("util");
var EventEmitter = require("events");
var dgram = require('dgram');   // for UDP

// Define our external module requirements
var HomeKitDevice = require("./HomeKitDevice");
const MDNSPROVIDER = HAP.MDNSAdvertiser.CIAO;                   // mDNS Provider we'll use 
const ACCESSORYNAME = "Sony";                                   // Used for manufacturer name of HomeKit device
const ACCESSORYPINCODE = "031-45-154";                          // HomeKit pairing code

// Define some extra remote commands that aren't in the HAP spec
HAP.Characteristic.RemoteKey.SETTINGS = 101;
HAP.Characteristic.RemoteKey.PLAY = 102;
HAP.Characteristic.RemoteKey.PAUSE = 102;
HAP.Characteristic.RemoteKey.HOME = 103;


// Sony Television class
const InputCategory = {
    PHYSICAL : 0,
    TUNERS : 1,
    CHANNELS : 2,
    APPLICATIONS : 3
}

class TelevisionClass extends HomeKitDevice {
    constructor(initialDeviceData, globalEventEmitter) {
        super(ACCESSORYNAME, ACCESSORYPINCODE, MDNSPROVIDER, initialDeviceData, globalEventEmitter);

        this.TVService = null;                      // HomeKit service for the TV
        this.speakerService = null;                 // HomeKit service for volume control
        this.TVInputs = [];                         // Array of input objects for things such as: inputs, tuners and/or channels
        this.cachedOptions = {};                    // Options we need to cache for later selecting
    }

    // Class functions
    addHomeKitServices(serviceName) {
        // Add this television to the "master" accessory and set properties
        this.TVService = this.HomeKitAccessory.addService(HAP.Service.Television, "Television", 1);
        this.TVService.setCharacteristic(HAP.Characteristic.ConfiguredName, "Television");
        this.TVService.setCharacteristic(HAP.Characteristic.SleepDiscoveryMode, HAP.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
        this.TVService.setCharacteristic(HAP.Characteristic.ClosedCaptions, HAP.Characteristic.ClosedCaptions.DISABLED);

        // Add a TV speaker to the "master" accessory and set properties
        this.speakerService = this.HomeKitAccessory.addService(HAP.Service.TelevisionSpeaker);
        this.speakerService.setCharacteristic(HAP.Characteristic.VolumeControlType, HAP.Characteristic.VolumeControlType.ABSOLUTE);

        // Add inputs to the "master" accessory and set properties
        this.#buildInputs([InputCategory.PHYSICAL, InputCategory.TUNERS]);

        // Setup callbacks for characteristics
        this.TVService.getCharacteristic(HAP.Characteristic.Active).on("set", this.setPower.bind(this));
        this.TVService.getCharacteristic(HAP.Characteristic.ActiveIdentifier).on("set", this.setInput.bind(this));
        this.TVService.getCharacteristic(HAP.Characteristic.RemoteKey).on("set", this.sendRemoteKey.bind(this));
        this.TVService.getCharacteristic(HAP.Characteristic.PowerModeSelection).on("set", this.accessSettings.bind(this));
        this.speakerService.getCharacteristic(HAP.Characteristic.VolumeSelector).on("set", this.setVolume.bind(this));

        this.HomeKitAccessory.setPrimaryService(this.TVService);

        outputLogging(ACCESSORYNAME, false, "Setup Sony Television '%s'", serviceName);
    }

    setPower(value, callback) {
        var powerState = (value == HAP.Characteristic.Active.ACTIVE) ? true : false
        this.set({"url": "/sony/system", "post": {"method": "setPowerStatus", "id": 55, "params": [{"status": powerState}], "version": "1.0"} });
        this.cachedOptions.power = powerState;
        callback();
    }

    setInput(value, callback) {
        // Switches active input on the TV
        var input = this.TVInputs.find(({uuid}) => uuid === value);
        if (typeof input != "undefined") {
            this.set({"url": "/sony/avContent", "post": {"method": "setPlayContent", "id": 13, "params": [{"uri": input.uri}],  "version": "1.0"} });
            
            this.cachedOptions.activeinput = {"input" : input.uri, "source" : ""};
        }
        callback();
    }

    setVolume(value, callback) {
        if (this.TVService.getCharacteristic(HAP.Characteristic.Active).value == HAP.Characteristic.Active.ACTIVE) {
            this.set({"url": "/sony/audio", "post": {"method": "setAudioVolume", "id": 601, "params": [{"target": "speaker", "volume": (value == HAP.Characteristic.VolumeSelector.INCREMENT ? "+1" : "-1")}],  "version": "1.0"} });
        }
        callback();
    }

    accessSettings(value, callback) {
        if (value == HAP.Characteristic.PowerModeSelection.SHOW) {
            this.sendRemoteKey(HAP.Characteristic.RemoteKey.SETTINGS, null);
        }
        callback(); // accessed TV settings
    }
    
    sendRemoteKey(value, callback) {
        // TODO - handle special case on play/pause which HomeKit sends, rather than seperate Play and pause commands Sony accepts
        var index = this.deviceData.remoteCommands.findIndex(({id}) => id === value);
        if (index != -1 && this.deviceData.remoteCommands[index].command != "") {
            var IRCCBodyRequest = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1"><IRCCCode>' + this.deviceData.remoteCommands[index].command + '</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>';
            this.set({"url": "/sony/IRCC", "post": IRCCBodyRequest, "headers" : { "Content-Type": "text/xml", "soapaction": '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"' } });
        }
        if (typeof callback === 'function') callback();  // do callback if defined
    }

    updateHomeKitServices(deviceData) {
        // Insert any cached parameters we have stored. 
        Object.entries(this.cachedOptions).forEach(([key, value]) => {
            if (JSON.stringify(deviceData[key]) == JSON.stringify(this.deviceData[key]) && JSON.stringify(deviceData[key]) != JSON.stringify(value)) {
                // Since the new data from the device matches the existing device data, use value from cache
                deviceData[key] = value;
            } else if (JSON.stringify(deviceData[key]) != JSON.stringify(this.deviceData[key])) {
                // New data for this key is different than our internally stored data, so we'll assume a change was triggered on external system
                delete this.cachedOptions[key];
            } else if (JSON.stringify(value) == JSON.stringify(deviceData[key]) && JSON.stringify(value) == JSON.stringify(this.deviceData[key])) {
                // Our cached value now matches the incoming device data, so remove from cache
                delete this.cachedOptions[key];
            }
        });

        if (this.TVService != null) {
            this.TVService.updateCharacteristic(HAP.Characteristic.Active, (deviceData.power == true ? HAP.Characteristic.Active.ACTIVE : HAP.Characteristic.Active.INACTIVE));
            this.HomeKitAccessory.getService(HAP.Service.AccessoryInformation).updateCharacteristic(HAP.Characteristic.FirmwareRevision, deviceData.software_version);

            // Update input active input
            if (deviceData.power == true && deviceData.activeinput.input != "") {
                var input = this.TVInputs.find(({uri}) => uri === deviceData.activeinput.input);
                if (typeof input != "undefined") {
                    this.TVService.getCharacteristic(HAP.Characteristic.ActiveIdentifier).updateValue(input.uuid);
                    if (input.type == HAP.Characteristic.InputSourceType.TUNER && deviceData.activeinput.source != "") {
                        // Since this active input is a tuner, we'll put the "channel name" in () after the tuner name
                    }
                };
            }
        }
        if (this.speakerService != null) {
            this.speakerService.updateCharacteristic(HAP.Characteristic.Active, (deviceData.power == true ? HAP.Characteristic.Active.ACTIVE : HAP.Characteristic.Active.INACTIVE));
            this.speakerService.updateCharacteristic(HAP.Characteristic.Volume, deviceData.volume);
            this.speakerService.updateCharacteristic(HAP.Characteristic.Mute, deviceData.mute);
        }
    }

    #buildInputs(inputBuildTypes) {
        if (typeof inputBuildTypes == "object") {
            this.deviceData.inputs.forEach(input => {
                if (inputBuildTypes.includes(InputCategory.TUNERS) && input.type == InputTypes.TVTUNER) {
                    this.TVInputs.push(new Input(this.HomeKitAccessory, input.title, HAP.Characteristic.InputSourceType.TUNER, input.uri, input.hidden, this.TVInputs.length + 1, null, null));
                } 
                if (inputBuildTypes.includes(InputCategory.PHYSICAL) && (input.type == InputTypes.HDMI || input.type == InputTypes.COMPONENT || input.type == InputTypes.SVIDEO || input.type == InputTypes.COMPOSITE || input.type == InputTypes.SCREENCAST || input.type == InputTypes.OTHER)) {
                    var inputName = ((input.label == "") ? input.title : input.title + " (" + input.label + ")");
                    var type = HAP.Characteristic.InputSourceType.OTHER;
                    if (input.type == InputTypes.HDMI) type = HAP.Characteristic.InputSourceType.HDMI;
                    if (input.type == InputTypes.COMPONENT) type = HAP.Characteristic.InputSourceType.COMPONENT_VIDEO;
                    if (input.type == InputTypes.SVIDEO) type = HAP.Characteristic.InputSourceType.S_VIDEO;
                    if (input.type == InputTypes.COMPOSITE) type = HAP.Characteristic.InputSourceType.COMPOSITE_VIDEO;
                    if (input.type == InputTypes.SCREENCAST) type = HAP.Characteristic.InputSourceType.AIRPLAY;
                    this.TVInputs.push(new Input(this.HomeKitAccessory, inputName, type, input.uri, input.hidden, this.TVInputs.length + 1, null, null));
                }
                if (inputBuildTypes.includes(InputCategory.CHANNELS) && (input.type == InputTypes.TVCHANNEL || input.type == InputTypes.TVRADIO)) {
                    this.TVInputs.push(new Input(this.HomeKitAccessory, input.title, HAP.Characteristic.InputSourceType.OTHER, input.uri, input.hidden, this.TVInputs.length + 1, null, null));
                } 
                if (inputBuildTypes.includes(InputCategory.APPLICATIONS) && (input.type == InputTypes.APPLICAION)) {
                    this.TVInputs.push(new Input(this.HomeKitAccessory, input.title, HAP.Characteristic.InputSourceType.APPLICATION, input.uri, input.hidden, this.TVInputs.length + 1, null, null));
                }
            });
        }
    }
}

// Input Class
class Input {
    constructor(HomeKitAccessory, name, type, uri, hidden, index, namecallback, visabilitycallback) {
        this.inputService = null;                       // HomeKit service for the input
        this.uri = uri;                                 // Store the input URI
        this.uuid = this.#crc32(uri);                   // Create a uuid for this input with a crc32 value of the uri
        this.type = type;                               // Store the input HomeKit Type
        this.namecallback = namecallback;               // Callback if input name changed (uri, name)
        this.visabilitycallback = visabilitycallback;   // Callback if input visability has changed (uri, visability)

        // Add this input to the "master" accessory and set properties
        this.inputService = HomeKitAccessory.addService(HAP.Service.InputSource, name, index);
        this.inputService.updateCharacteristic(HAP.Characteristic.Name, name);
        this.inputService.updateCharacteristic(HAP.Characteristic.ConfiguredName, name);
        this.inputService.updateCharacteristic(HAP.Characteristic.InputSourceType, type);
        this.inputService.updateCharacteristic(HAP.Characteristic.IsConfigured, HAP.Characteristic.IsConfigured.CONFIGURED);
        this.inputService.updateCharacteristic(HAP.Characteristic.CurrentVisibilityState, HAP.Characteristic.CurrentVisibilityState.SHOWN);
        this.inputService.updateCharacteristic(HAP.Characteristic.CurrentVisibilityState, (hidden == true ? HAP.Characteristic.CurrentVisibilityState.HIDDEN : HAP.Characteristic.CurrentVisibilityState.SHOWN));
        this.inputService.updateCharacteristic(HAP.Characteristic.TargetVisibilityState, (hidden == true ? HAP.Characteristic.CurrentVisibilityState.HIDDEN : HAP.Characteristic.CurrentVisibilityState.SHOWN));    
        this.inputService.updateCharacteristic(HAP.Characteristic.Identifier, this.uuid);
        //this.inputService.updateCharacteristic(HAP.Characteristic.InputDeviceType, xxxx);
    
        // Setup set callbacks for characteristics
        this.inputService.getCharacteristic(HAP.Characteristic.TargetVisibilityState).on("set", this.setVisability.bind(this));
        this.inputService.getCharacteristic(HAP.Characteristic.ConfiguredName).on("set", this.setName.bind(this));

        // Link this input to the TV Service
        HomeKitAccessory.getService(HAP.Service.Television).addLinkedService(this.inputService);
    }

    setName(value, callback) {     
        // Update inputs name in HomeKit
        this.inputService.updateCharacteristic(HAP.Characteristic.ConfiguredName, value);
        callback();

        if (typeof this.namecallback == "function") this.namecallback(this.uri, value);  // Call back after name changed
    }

    setVisability(value, callback) {
        // Allow enabling/disabling input within Homekit
        this.inputService.updateCharacteristic(HAP.Characteristic.CurrentVisibilityState, value);
        this.inputService.updateCharacteristic(HAP.Characteristic.TargetVisibilityState, value);
        callback();

        if (typeof this.visabilitycallback == "function") this.visabilitycallback(this.uri, value);  // Call back after name changed
    }

    #crc32(valueToHash) {
        var crc32HashTable = [
            0x000000000, 0x077073096, -0x11f19ed4, -0x66f6ae46, 0x0076dc419, 0x0706af48f, -0x169c5acb, -0x619b6a5d, 
            0x00edb8832, 0x079dcb8a4, -0x1f2a16e2, -0x682d2678, 0x009b64c2b, 0x07eb17cbd, -0x1847d2f9, -0x6f40e26f, 
            0x01db71064, 0x06ab020f2, -0xc468eb8, -0x7b41be22, 0x01adad47d, 0x06ddde4eb, -0xb2b4aaf, -0x7c2c7a39, 
            0x0136c9856, 0x0646ba8c0, -0x29d0686, -0x759a3614, 0x014015c4f, 0x063066cd9, -0x5f0c29d, -0x72f7f20b, 
            0x03b6e20c8, 0x04c69105e, -0x2a9fbe1c, -0x5d988e8e, 0x03c03e4d1, 0x04b04d447, -0x2df27a03, -0x5af54a95, 
            0x035b5a8fa, 0x042b2986c, -0x2444362a, -0x534306c0, 0x032d86ce3, 0x045df5c75, -0x2329f231, -0x542ec2a7, 
            0x026d930ac, 0x051de003a, -0x3728ae80, -0x402f9eea, 0x021b4f4b5, 0x056b3c423, -0x30456a67, -0x47425af1, 
            0x02802b89e, 0x05f058808, -0x39f3264e, -0x4ef416dc, 0x02f6f7c87, 0x058684c11, -0x3e9ee255, -0x4999d2c3, 
            0x076dc4190, 0x001db7106, -0x672ddf44, -0x102aefd6, 0x071b18589, 0x006b6b51f, -0x60401b5b, -0x17472bcd, 
            0x07807c9a2, 0x00f00f934, -0x69f65772, -0x1ef167e8, 0x07f6a0dbb, 0x0086d3d2d, -0x6e9b9369, -0x199ca3ff, 
            0x06b6b51f4, 0x01c6c6162, -0x7a9acf28, -0xd9dffb2, 0x06c0695ed, 0x01b01a57b, -0x7df70b3f, -0xaf03ba9, 
            0x065b0d9c6, 0x012b7e950, -0x74414716, -0x3467784, 0x062dd1ddf, 0x015da2d49, -0x732c830d, -0x42bb39b, 
            0x04db26158, 0x03ab551ce, -0x5c43ff8c, -0x2b44cf1e, 0x04adfa541, 0x03dd895d7, -0x5b2e3b93, -0x2c290b05, 
            0x04369e96a, 0x0346ed9fc, -0x529877ba, -0x259f4730, 0x044042d73, 0x033031de5, -0x55f5b3a1, -0x22f28337, 
            0x05005713c, 0x0270241aa, -0x41f4eff0, -0x36f3df7a, 0x05768b525, 0x0206f85b3, -0x46992bf7, -0x319e1b61, 
            0x05edef90e, 0x029d9c998, -0x4f2f67de, -0x3828574c, 0x059b33d17, 0x02eb40d81, -0x4842a3c5, -0x3f459353, 
            -0x12477ce0, -0x65404c4a, 0x003b6e20c, 0x074b1d29a, -0x152ab8c7, -0x622d8851, 0x004db2615, 0x073dc1683, 
            -0x1c9cf4ee, -0x6b9bc47c, 0x00d6d6a3e, 0x07a6a5aa8, -0x1bf130f5, -0x6cf60063, 0x00a00ae27, 0x07d079eb1, 
            -0xff06cbc, -0x78f75c2e, 0x01e01f268, 0x06906c2fe, -0x89da8a3, -0x7f9a9835, 0x0196c3671, 0x06e6b06e7, 
            -0x12be48a, -0x762cd420, 0x010da7a5a, 0x067dd4acc, -0x6462091, -0x71411007, 0x017b7be43, 0x060b08ed5, 
            -0x29295c18, -0x5e2e6c82, 0x038d8c2c4, 0x04fdff252, -0x2e44980f, -0x5943a899, 0x03fb506dd, 0x048b2364b, 
            -0x27f2d426, -0x50f5e4b4, 0x036034af6, 0x041047a60, -0x209f103d, -0x579820ab, 0x0316e8eef, 0x04669be79, 
            -0x349e4c74, -0x43997ce6, 0x0256fd2a0, 0x05268e236, -0x33f3886b, -0x44f4b8fd, 0x0220216b9, 0x05505262f, 
            -0x3a45c442, -0x4d42f4d8, 0x02bb45a92, 0x05cb36a04, -0x3d280059, -0x4a2f30cf, 0x02cd99e8b, 0x05bdeae1d, 
            -0x649b3d50, -0x139c0dda, 0x0756aa39c, 0x0026d930a, -0x63f6f957, -0x14f1c9c1, 0x072076785, 0x005005713, 
            -0x6a40b57e, -0x1d4785ec, 0x07bb12bae, 0x00cb61b38, -0x6d2d7165, -0x1a2a41f3, 0x07cdcefb7, 0x00bdbdf21, 
            -0x792c2d2c, -0xe2b1dbe, 0x068ddb3f8, 0x01fda836e, -0x7e41e933, -0x946d9a5, 0x06fb077e1, 0x018b74777, 
            -0x77f7a51a, -0xf09590, 0x066063bca, 0x011010b5c, -0x709a6101, -0x79d5197, 0x0616bffd3, 0x0166ccf45, 
            -0x5ff51d88, -0x28f22d12, 0x04e048354, 0x03903b3c2, -0x5898d99f, -0x2f9fe909, 0x04969474d, 0x03e6e77db, 
            -0x512e95b6, -0x2629a524, 0x040df0b66, 0x037d83bf0, -0x564351ad, -0x2144613b, 0x047b2cf7f, 0x030b5ffe9, 
            -0x42420de4, -0x35453d76, 0x053b39330, 0x024b4a3a6, -0x452fc9fb, -0x3228f96d, 0x054de5729, 0x023d967bf, 
            -0x4c9985d2, -0x3b9eb548, 0x05d681b02, 0x02a6f2b94, -0x4bf441c9, -0x3cf3715f, 0x05a05df1b, 0x02d02ef8d
        ]
        var crc32 = 0xffffffff; // init crc32 hash;
        valueToHash = Buffer.from(valueToHash);    // convert value into buffer for processing
        for (var index = 0; index < valueToHash.length; index++) {
            crc32 = (crc32HashTable[(crc32 ^ valueToHash[index]) & 0xff] ^ crc32 >>> 8) & 0xffffffff;
        }
        crc32 ^= 0xffffffff;
        return crc32 >>> 0;    // return crc32
    }
}


// Sony TV class
const UPDTIMEOUT = 5000;
const UDPDISCOVERYDONE = "UDPDISCOVERYDONE";
const NETWORKDISCOVERY = 30000; // Perform UDP discovery every 30seconds
const SYSTEMREFRESH = 2000; // Get system details for each discovered system every 2 seconds
const SONYTVPSK = "0000";                               // PSK key

const SystemEvent = {
    ADD : "addDevice",
    REMOVE : "removeDevice"
}

const InputTypes = {
    HDMI : "HDMI",
    COMPONENT : "COMPONENT",
    SVIDEO : "SVIDEO",
    COMPOSITE : "COMPOSITE",
    SCREENCAST : "SCREENCAST",
    TVTUNER : "TUNER",
    TVRADIO : "RADIO",
    TVCHANNEL : "CHANNEL",
    APPLICAION : "APPLICATION",
    OTHER : "OTHER"
}

class SonyTV {
	constructor(globalEventEmitter) {
        this.rawData = {};                                  // Full copy of SonyTV data
        this.abortController = new AbortController();       // Abort controller object
        this.eventEmitter = globalEventEmitter;             // Global event emitter
        this.subscribePollingTimers = [];                   // Array of polling timers for subscribe requests
        this.systems = [];                                  // Array of systems we've discovered and managing (JSON object)

        // Setup event processing for set/get properties
        this.eventEmitter.addListener(HomeKitDevice.SET, this.#set.bind(this));
        this.eventEmitter.addListener(HomeKitDevice.GET, this.#get.bind(this));
    }

    // Class functions
    async discover() 
    {
        // Find systems on local network
        var foundSystems = [];
        var udpSocket = dgram.createSocket({type: "udp4", reuseAddr: true});
        
        udpSocket.bind(0, "0.0.0.0", () => {
            udpSocket.addMembership("224.0.0.1");
            udpSocket.setBroadcast(true);
        });
        
        udpSocket.on("message", async (chunk, info) => {        
            // Callback triggered when we've received a UDP response
            if (foundSystems.some(ip => ip.IPAddress === info.address) == false) {
                // Have not found this device before, so add to array of discovered systems
                await axios.post("http://" + info.address + "/sony/system", {"method": "getSystemInformation", "id": 33, "params": [""], "version": "1.0"}, {headers: {"X-Auth-PSK": SONYTVPSK}})
                .then(response => {
                    if (response.status == 200 && response.data.result) {
                        if (foundSystems.findIndex( ({ IPAddress, MAC }) => (MAC == response.data.result[0].macAddr.toUpperCase())) == -1) {
                            foundSystems.push({MAC: response.data.result[0].macAddr.toUpperCase(), IPAddress: info.address, URL: ""});
                        }
                    }
                })
                .catch((error) => {
                });
            }
        });
    
        udpSocket.on("listening", () => {
            // UDP socket opened to listen, so send the queries
            var udpQuery = 
            "M-SEARCH * HTTP/1.1\r\n" +
            "HOST:239.255.255.250:1900\r\n" +
            "MAN:\"ssdp:discover\"\r\n" +
            "ST:urn:schemas-sony-com:service:ScalarWebAPI:1\r\n" + 
            "MX:2\r\n" +
            "\r\n";
            udpSocket.send(udpQuery, 0, udpQuery.length, 1900, "239.255.255.250");
    
            // Sent the discovery messages, so wait for replies 
            setTimeout(() => {
                udpSocket.close();
                this.eventEmitter.emit(UDPDISCOVERYDONE);
            }, UPDTIMEOUT);
        });

        // Wait until we get notified that discovery has completed/reached timeout
        await EventEmitter.once(this.eventEmitter, UDPDISCOVERYDONE);
        return foundSystems;
    }

    async getData(systems) {
        await Promise.all(systems.map(async (system) => {
            await axios.all([
                axios.post("http://" + system.IPAddress + "/sony/system", {"method": "getPowerStatus", "id": 50, "params": [""],  "version": "1.0"}, {headers: {"X-Auth-PSK": SONYTVPSK}}),
                axios.post("http://" + system.IPAddress + "/sony/avContent", {"method": "getPlayingContentInfo", "id": 103, "params": [""],  "version": "1.0"}, {headers: {"X-Auth-PSK": SONYTVPSK}}),
                axios.post("http://" + system.IPAddress + "/sony/audio", {"method": "getVolumeInformation", "id": 33, "params": [""],  "version": "1.0"} , {headers: {"X-Auth-PSK": SONYTVPSK}}),
                axios.post("http://" + system.IPAddress + "/sony/system", {"method": "getSystemInformation", "id": 33, "params": [""], "version": "1.0"}, {headers: {"X-Auth-PSK": SONYTVPSK}}),
                axios.post("http://" + system.IPAddress + "/sony/avContent", {"method": "getCurrentExternalInputsStatus", "id": 105, "params": [""], "version": "1.0"}, {headers: {"X-Auth-PSK": SONYTVPSK}}),
                axios.post("http://" + system.IPAddress + "/sony/avContent", {"method": "getSourceList", "id": 1, "params": [{"scheme": "tv"}], "version": "1.0"}, {headers: {"X-Auth-PSK": SONYTVPSK}}),
                axios.post("http://" + system.IPAddress + "/sony/appControl", {"method": "getApplicationList", "id": 60, "params": [""], "version": "1.0"}, {headers: {"X-Auth-PSK": SONYTVPSK}}),
                axios.post("http://" + system.IPAddress + "/sony/system", {"method": "getRemoteControllerInfo", "id": 1, "params": [""],  "version": "1.0"}, {headers: {"X-Auth-PSK": SONYTVPSK}}),
            ])
            .then(axios.spread(async (power, activeinput, volume, info, inputnames, tunerlist, applist, remoteinfo) => {
                this.rawData[system.MAC] = {};
                if (power.status == 200 && power.data.result) {
                    this.rawData[system.MAC].power = power.data.result[0];
                }
                if (activeinput.status == 200 && activeinput.data.result) {
                    this.rawData[system.MAC].activeinput = activeinput.data.result[0];
                }
                if (volume.status == 200 && volume.data.result) {
                    this.rawData[system.MAC].volume = volume.data.result[0];
                }
                if (info.status == 200 && info.data.result) {
                    this.rawData[system.MAC].info = info.data.result[0];
                }
                if (inputnames.status == 200 && inputnames.data.result) {
                    this.rawData[system.MAC].inputnames = inputnames.data.result[0];
                }
                if (tunerlist.status == 200 && tunerlist.data.result) {
                    this.rawData[system.MAC].tunerlist = tunerlist.data.result[0];

                    // Get channel data here for each tuner
                    await Promise.all(tunerlist.data.result[0].map(async (tuner) => {
                        this.rawData[system.MAC].channels = [];
                        await axios.post("http://" + system.IPAddress + "/sony/avContent", {"method": "getContentList", "id": 2, "params": [{"source": tuner.source, "stIx": 0}], "version": "1.2"}, {headers: {"X-Auth-PSK": SONYTVPSK}})
                        .then(response => {
                            if (response.status == 200 && response.data.result) {
                                this.rawData[system.MAC].channels[tuner.source] = response.data.result[0];
                            }
                        });
                    }));
                }
                if (applist.status == 200 && applist.data.result) {
                    this.rawData[system.MAC].applications = applist.data.result[0];
                }
                if (remoteinfo.status == 200 && remoteinfo.data.result) {
                    this.rawData[system.MAC].remoteinfo = remoteinfo.data.result[1];
                }
                this.rawData[system.MAC].online = true; // We've processed data, so we're online
                this.systems.push({MAC: system.MAC, IPAddress: system.IPAddress});  // Add this device to systems we're managing
            }))
            .catch(error => {
            });
        }));
    }

    processData() {
        var devices = {};

        Object.entries(this.rawData).forEach(([MAC, device]) => {
            // process raw device data
            var tempDevice = {};
            tempDevice.excluded = false;
            tempDevice.manufacturer = ACCESSORYNAME;
            tempDevice.serial_number = device.info.serial;
            tempDevice.description = this.#validateHomeKitName(device.info.model);
            tempDevice.model = device.info.model;
            tempDevice.location = "";    // no location of the device name
            tempDevice.mac_address = MAC;   // Our created MAC address
            tempDevice.uuid = MAC;
            tempDevice.software_version = device.info.generation.replace(/_/g, ".");

            tempDevice.power = (device.power.status.toUpperCase() == "ACTIVE" ? true : false);

            // Process volume information
            tempDevice.volume = 0;  // No volume information as yet
            tempDevice.mute = true; // Device is muted
            if (device.hasOwnProperty("volume") == true) {
                device.volume.forEach(volumeInfo => {
                    if (volumeInfo.target.toUpperCase() == "SPEAKER") {
                        tempDevice.volume = scaleValue(volumeInfo.volume, volumeInfo.minVolume, volumeInfo.maxVolume, 0, 100);
                        tempDevice.mute = volumeInfo.mute;
                    }
                });
            }

            // Generate list of inputs, which includes tuners, channels and applications
            tempDevice.inputs = [];
            if (device.hasOwnProperty("inputnames") == true) {
                device.inputnames.forEach(input => {
                    var type = InputTypes.OTHER;
                    // Determine the input type by the "icon" tag. Split after the "meta:" entry for the type
                    if (input.icon.split(":")[1].toUpperCase() == "HDMI" || input.icon.split(":")[1].toUpperCase() == "CEC" ) type = InputTypes.HDMI;
                    if (input.icon.split(":")[1].toUpperCase() == "COMPONENT" || input.icon.split(":")[1].toUpperCase() == "COMPONENTD") type = InputTypes.COMPONENT;
                    if (input.icon.split(":")[1].toUpperCase() == "SVIDEO") type = InputTypes.SVIDEO;
                    if (input.icon.split(":")[1].toUpperCase() == "COMPOSITE") type = InputTypes.COMPOSITE;
                    if (input.icon.split(":")[1].toUpperCase() == "WIFIDISPLAY") type = InputTypes.SCREENCAST;
                    if (input.icon.split(":")[1].toUpperCase() == "TUNERDEVICE" || input.icon.split(":")[1].toUpperCase() == "TUNER" || input.icon.split(":")[1].toUpperCase() == "TV") type = InputTypes.TVTUNER;
                    tempDevice.inputs.push({"uri" : input.uri, "title": input.title, "label" : input.label, "connection" : input.connection, "type" : type, "hidden" : false, "canhide" : false, "canrename" : false});
                });
            }
            if (device.hasOwnProperty("tunerlist") == true) {
                device.tunerlist.forEach(input => {
                    var title = "";
                    if (input.source.toUpperCase() == "TV:DVBT") title = "Digital Tuner";
                    if (input.source.toUpperCase() == "TV:ANALOG") tile = "Analog Tuner";
                    if (input.source.toUpperCase() == "TV:DVBC") title = "Cable Tuner";
                    if (input.source.toUpperCase() == "TV:DVBS") title = "Satellite Tuner";
                    if (title != "") tempDevice.inputs.push({"uri" : input.source, "title": title, "label" : "", "connection" : true, "type" : InputTypes.TVTUNER, "hidden" : false, "canhide" : false, "canrename" : false});
                });
            }
            if (device.hasOwnProperty("channels") == true) {
                Object.entries(device.channels).map(([source, channels]) => {
                    channels.forEach(channel => {
                        var type = "";
                        if (channel.programMediaType.toUpperCase() == "TV") type = InputTypes.TVCHANNEL;
                        if (channel.programMediaType.toUpperCase() == "RADIO") type = InputTypes.TVRADIO;
                        if (type != "") tempDevice.inputs.push({"uri" : channel.uri, "title": channel.title, "label" : channel.dispNum, "connection" : true, "type" : type, "hidden" : false, "canhide" : false, "canrename" : false});
                    });
                });
            }
            if (device.hasOwnProperty("applications") == true) {
                device.applications.forEach(application => {
                    tempDevice.inputs.push({"uri" : application.uri, "title": application.title, "label" : "", "connection" : true, "type" : InputTypes.APPLICAION, "hidden" : false, "canhide" : false, "canrename" : false});
                });
            }

            // Lets work out which input(s) are active
            tempDevice.activeinput = {"input": "", "source": ""};
            if (device.hasOwnProperty("activeinput") == true) {
                tempDevice.activeinput.input = (tempDevice.inputs.findIndex(({uri}) => uri === device.activeinput.source) != -1 ? device.activeinput.source : device.activeinput.uri);
                tempDevice.activeinput.source = device.activeinput.uri;
            }

            // Get remote commands
            tempDevice.remoteCommands = [];
            if (device.hasOwnProperty("remoteinfo") == true) {
                device.remoteinfo.forEach(remote => {
                    if (remote.name.toUpperCase() == "REWIND") tempDevice.remoteCommands.push({"id": HAP.Characteristic.RemoteKey.REWIND, "command": remote.value});
                    if (remote.name.toUpperCase() == "FORWARD") tempDevice.remoteCommands.push({"id": HAP.Characteristic.RemoteKey.FAST_FORWARD, "command": remote.value});
                    if (remote.name.toUpperCase() == "NEXT") tempDevice.remoteCommands.push({"id": HAP.Characteristic.RemoteKey.NEXT_TRACK, "command": remote.value});
                    if (remote.name.toUpperCase() == "PREV") tempDevice.remoteCommands.push({"id": HAP.Characteristic.RemoteKey.PREVIOUS_TRACK, "command": remote.value});
                    if (remote.name.toUpperCase() == "UP") tempDevice.remoteCommands.push({"id": HAP.Characteristic.RemoteKey.ARROW_UP, "command": remote.value});
                    if (remote.name.toUpperCase() == "DOWN") tempDevice.remoteCommands.push({"id": HAP.Characteristic.RemoteKey.ARROW_DOWN, "command": remote.value});
                    if (remote.name.toUpperCase() == "LEFT") tempDevice.remoteCommands.push({"id": HAP.Characteristic.RemoteKey.ARROW_LEFT, "command": remote.value});
                    if (remote.name.toUpperCase() == "RIGHT") tempDevice.remoteCommands.push({"id": HAP.Characteristic.RemoteKey.ARROW_RIGHT, "command": remote.value});
                    if (remote.name.toUpperCase() == "CONFIRM") tempDevice.remoteCommands.push({"id": HAP.Characteristic.RemoteKey.SELECT, "command": remote.value});
                    if (remote.name.toUpperCase() == "RETURN") tempDevice.remoteCommands.push({"id": HAP.Characteristic.RemoteKey.BACK, "command": remote.value});
                    if (remote.name.toUpperCase() == "EXIT") tempDevice.remoteCommands.push({"id": HAP.Characteristic.RemoteKey.EXIT, "command": remote.value});
                    if (remote.name.toUpperCase() == "PLAY") tempDevice.remoteCommands.push({"id": HAP.Characteristic.RemoteKey.PLAY, "command": remote.value});
                    if (remote.name.toUpperCase() == "PAUSE") tempDevice.remoteCommands.push({"id": HAP.Characteristic.RemoteKey.PAUSE, "command": remote.value});
                    if (remote.name.toUpperCase() == "DISPLAY") tempDevice.remoteCommands.push({"id": HAP.Characteristic.RemoteKey.INFORMATION, "command": remote.value});
                    if (remote.name.toUpperCase() == "ACTIONMENU") tempDevice.remoteCommands.push({"id": HAP.Characteristic.RemoteKey.SETTINGS, "command": remote.value});
                    if (remote.name.toUpperCase() == "HOME") tempDevice.remoteCommands.push({"id": HAP.Characteristic.RemoteKey.HOME, "command": remote.value});
                });
            }

            tempDevice.online = device.online;                      // Device is online
           
            devices[MAC] = tempDevice;  // Store processed device 
        });

        return devices; // Return our processed data
    }

    async subscribe() {
        this.systems.forEach((system) => {
            // Setup a timer interval for each system we have discovered previously
            var index = this.subscribePollingTimers.findIndex( ({ MAC }) => (MAC === system.MAC));
            if (index == -1 || (index != -1 && this.subscribePollingTimers[index].timer == null)) {
                var tempTimer = setInterval(async () => {
                    await axios.all([
                        axios.post("http://" + system.IPAddress + "/sony/system", {"method": "getPowerStatus", "id": 50, "params": [""],  "version": "1.0"}, {headers: {"X-Auth-PSK": SONYTVPSK}}),
                        axios.post("http://" + system.IPAddress + "/sony/avContent", {"method": "getPlayingContentInfo", "id": 103, "params": [""],  "version": "1.0"}, {headers: {"X-Auth-PSK": SONYTVPSK}}),
                        axios.post("http://" + system.IPAddress + "/sony/audio", {"method": "getVolumeInformation", "id": 33, "params": [""],  "version": "1.0"} , {headers: {"X-Auth-PSK": SONYTVPSK}}),
                        axios.post("http://" + system.IPAddress + "/sony/system", {"method": "getSystemInformation", "id": 33, "params": [""], "version": "1.0"}, {headers: {"X-Auth-PSK": SONYTVPSK}}),
                        axios.post("http://" + system.IPAddress + "/sony/avContent", {"method": "getCurrentExternalInputsStatus", "id": 105, "params": [""], "version": "1.0"}, {headers: {"X-Auth-PSK": SONYTVPSK}}),
                        axios.post("http://" + system.IPAddress + "/sony/avContent", {"method": "getSourceList", "id": 1, "params": [{"scheme": "tv"}], "version": "1.0"}, {headers: {"X-Auth-PSK": SONYTVPSK}}),
                        axios.post("http://" + system.IPAddress + "/sony/appControl", {"method": "getApplicationList", "id": 60, "params": [""], "version": "1.0"}, {headers: {"X-Auth-PSK": SONYTVPSK}}),
                        axios.post("http://" + system.IPAddress + "/sony/system", {"method": "getRemoteControllerInfo", "id": 1, "params": [""],  "version": "1.0"}, {headers: {"X-Auth-PSK": SONYTVPSK}})
                    ])
                    .then(axios.spread(async (power, activeinput, volume, info, inputnames, tunerlist, applist, remoteinfo) => {
                        this.rawData[system.MAC] = {};
                        if (power.status == 200 && power.data.result) {
                            this.rawData[system.MAC].power = power.data.result[0];
                        }
                        if (activeinput.status == 200 && activeinput.data.result) {
                            this.rawData[system.MAC].activeinput = activeinput.data.result[0];
                        }
                        if (volume.status == 200 && volume.data.result) {
                            this.rawData[system.MAC].volume = volume.data.result[0];
                        }
                        if (info.status == 200 && info.data.result) {
                            this.rawData[system.MAC].info = info.data.result[0];
                        }
                        if (inputnames.status == 200 && inputnames.data.result) {
                            this.rawData[system.MAC].inputnames = inputnames.data.result[0];
                        }
                        if (tunerlist.status == 200 && tunerlist.data.result) {
                            this.rawData[system.MAC].tunerlist = tunerlist.data.result[0];
        
                            // Get channel data here for each tuner
                            await Promise.all(tunerlist.data.result[0].map(async (tuner) => {
                                this.rawData[system.MAC].channels = [];
                                await axios.post("http://" + system.IPAddress + "/sony/avContent", {"method": "getContentList", "id": 2, "params": [{"source": tuner.source, "stIx": 0}], "version": "1.2"}, {headers: {"X-Auth-PSK": SONYTVPSK}})
                                .then(response => {
                                    if (response.status == 200 && response.data.result) {
                                        this.rawData[system.MAC].channels[tuner.source] = response.data.result[0];
                                    }
                                })
                                .catch(error => {
                                });
                            }));
                        }
                        if (applist.status == 200 && applist.data.result) {
                            this.rawData[system.MAC].applications = applist.data.result[0];
                        }
                        if (remoteinfo.status == 200 && remoteinfo.data.result) {
                            this.rawData[system.MAC].remoteinfo = remoteinfo.data.result[1];
                        }
                        this.rawData[system.MAC].online = true; // We've processed data, so we're online

                        // Process any device updates here
                        Object.entries(this.processData()).forEach(([deviceID, deviceData]) => {
                            // Send current data to the HomeKit accessory for processing
                            // The accessory will determine if data has changed compared to what it has stored
                            this.eventEmitter.emit(deviceData.uuid, HomeKitDevice.UPDATE, deviceData);
                        });
                    }))
                    .catch(error => {
                    });
                }, SYSTEMREFRESH);   // Every 2 seconds
            }
            this.subscribePollingTimers.push({MAC: system.MAC, timer: tempTimer});
        });


        // Need a special timer loop to perform network discovery for adding/removing/ip changes devices
        // NOTE: Only checking for device additions/ip changes as UDP discovery can be unsuccessfull at times so a previous device may drop off then reappear     
        var tempTimer = setInterval(() => {
            this.discover()
            .then((discoveredSystems) => {
                var addRemoveDevices = [];
                for (var index in this.systems) {
                    if (discoveredSystems.findIndex( ({ IPAddress, MAC }) => (MAC == this.systems[index].MAC)) == -1) {
                        addRemoveDevices.push({"MAC" : this.systems[index].MAC, "IPAddress": this.systems[index].IPAddress, "action" : "remove"});    // Removed device
                    }
                }
                for (index in discoveredSystems) {
                    var index2 = this.systems.findIndex( ({ IPAddress, MAC }) => (MAC == discoveredSystems[index].MAC));
                    if (index2 == -1) {
                        addRemoveDevices.push({ "MAC" : discoveredSystems[index].MAC, "IPAddress": discoveredSystems[index].IPAddress, "action" : "add"});    // Added device
                    } else if (index2 != -1 && discoveredSystems[index].IPAddress != this.systems[index2].IPAddress) {
                        addRemoveDevices.push({"MAC" : discoveredSystems[index].MAC, "IPAddress": discoveredSystems[index].IPAddress, "action" : "ipchange"});    // IP change
                    }
                }

                addRemoveDevices = addRemoveDevices.sort((a, b) => a - b);  // filter out duplicates

                // Process changes for discovered devices now
                addRemoveDevices.forEach(async (system) => {
                    if (system.action == "add") {
                        await this.getData([{"IPAddress" : system.IPAddress, "MAC" : system.MAC}]);   // Get data for the new system and add to managed devices
                        var deviceData = this.processData()[system.MAC];   // Process all our current data
                        this.eventEmitter.emit(SystemEvent.ADD, deviceData);    // new device, so process addition to HomeKit

                        // Restart subscription loop gracefully
                        this.subscribePollingTimers.forEach(pollingTimer => {
                            clearInterval(pollingTimer.timer);
                            pollingTimer.timer = null;
                        });
                        this.subscribe();   // Restart subsription loops
                    }
                    if (system.action == "remove") {
                        // What todo???
                    }
                    if (system.action == "ipchange") {
                        // Systems IP address has changed, so update our internal managed system details for it
                        var index = this.systems.findIndex( ({ IPAddress, MAC }) => (MAC === system.MAC));
                        if (index != -1) {
                            outputLogging(ACCESSORYNAME, true, "Sony system '%s' has had IP Address change from '%s' to '%s'", system.MAC, this.systems[index].IPAddress, system.IPAddress);
                            this.systems[index].IPAddress = system.IPAddress;
                        }
                    }
                });
            });
        }, NETWORKDISCOVERY);      // Every 30 seconds?
        this.subscribePollingTimers.push({MAC: "", timer: tempTimer});
    }

    async #set(deviceUUID, keyValues) {
        if (typeof deviceUUID != "string" || typeof keyValues != "object") {
            return;
        }

        var index = this.systems.findIndex( ({ IPAddress, MAC }) => (MAC === deviceUUID));
        if (index != -1) {
            var postHeaders = {"X-Auth-PSK": SONYTVPSK};    // Default headers for post command
            if (keyValues.hasOwnProperty("headers") == true) {
                Object.entries(keyValues.headers).map(async ([key, value]) => {    
                    postHeaders[key] = value;   // Add in extra post header details
                });
            }

            await axios.post("http://" + this.systems[index].IPAddress + keyValues.url, keyValues.post, {headers: postHeaders})
            .then(response => {
                if (typeof response.status != "number" || response.status != 200) {
                    throw new Error("Sony API HTTP post failed with error");
                }
            })
            .catch((error) => {
            });
        }   
    }

    async #get(deviceUUID) {
    }

    #validateHomeKitName(nameToMakeValid) {
        // Strip invalid characters to meet HomeKit naming requirements
        // Ensure only letters or numbers are at the beginning AND/OR end of string
        return nameToMakeValid.replace(/[^A-Za-z0-9 ,.-]/g, "").replace(/^[^a-zA-Z0-9]*/g, "").replace(/[^a-zA-Z0-9]+$/g, "");
    }
}


// General functions

// Below taken from https://lifesaver.codes/answer/adding-retry-parameter
axios.interceptors.response.use(undefined, function axiosRetryInterceptor(err) {
    var config = err.config;
    // If config does not exist or the retry option is not set, reject
    if (!config || !config.retry) return Promise.reject(err);
    
    // Set the variable for keeping track of the retry count
    config.__retryCount = config.__retryCount || 0;
    
    // Check if we've maxed out the total number of retries
    if (config.__retryCount >= config.retry) {
        // Reject with the error
        return Promise.reject(err);
    }
    
    // Increase the retry count
    config.__retryCount += 1;
    
    // Create new promise to handle exponential backoff
    var backoff = new Promise(function(resolve) {
        setTimeout(function() {
            resolve();
        }, config.retryDelay || 1);
    });
    
    // Return the promise in which re-calls axios to retry the request
    return backoff.then(function() {
        return axios(config);
    });
});

function scaleValue(value, sourceRangeMin, sourceRangeMax, targetRangeMin, targetRangeMax) {
    if (value < sourceRangeMin) value = sourceRangeMin;
    if (value > sourceRangeMax) value = sourceRangeMax;
    return (value - sourceRangeMin) * (targetRangeMax - targetRangeMin) / (sourceRangeMax - sourceRangeMin) + targetRangeMin;
}

function outputLogging(accessoryName, useConsoleDebug, ...outputMessage) {
    var timeStamp = String(new Date().getFullYear()).padStart(4, "0") + "-" + String(new Date().getMonth() + 1).padStart(2, "0") + "-" + String(new Date().getDate()).padStart(2, "0") + " " + String(new Date().getHours()).padStart(2, "0") + ":" + String(new Date().getMinutes()).padStart(2, "0") + ":" + String(new Date().getSeconds()).padStart(2, "0");
    if (useConsoleDebug == false) {
        console.log(timeStamp + " [" + accessoryName + "] " + util.format(...outputMessage));
    }
    if (useConsoleDebug == true) {
        console.debug(timeStamp + " [" + accessoryName + "] " + util.format(...outputMessage));
    }
}

function processDeviceforHomeKit(deviceData) {
    if (typeof deviceData != "object" || deviceData.excluded == true) {
        return;
    }

    var tempDevice = new TelevisionClass(deviceData, eventEmitter);
    tempDevice.add("Sony Television", HAP.Accessory.Categories.TELEVISION, false);   
}


// Startup code
outputLogging(ACCESSORYNAME, false, "Starting " +  __filename + " using HAP-NodeJS library v" + HAP.HAPLibraryVersion());
outputLogging(ACCESSORYNAME, false, "Devices will be advertised to HomeKit using '%s' mDNS provider", MDNSPROVIDER);

// Need a global event emitter. Will be used for message between our classes we create
var eventEmitter = new EventEmitter();
var sonyTV = new SonyTV(eventEmitter);

outputLogging(ACCESSORYNAME, true, "Discovering active televisions on local network");

sonyTV.discover()
.then((discoveredSystems) => {
    sonyTV.getData(discoveredSystems)
    .then(() => {
        // Process any discovered daikin devices into HomeKit
        Object.entries(sonyTV.processData()).forEach(([deviceID, deviceData]) => {
            processDeviceforHomeKit(deviceData);
        });

        sonyTV.eventEmitter.addListener(SystemEvent.ADD, processDeviceforHomeKit); // Notifications for any device additions on the local network
        sonyTV.subscribe();  // Start subscription
    });
});