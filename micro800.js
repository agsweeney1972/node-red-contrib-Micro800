// Micro800 PLC Node for Node-RED
const Logix = require('node-logix'); // Import the whole module

module.exports = function(RED) {
    function Micro800Node(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const port = 44818; // Fixed port value

        // Removed: Log the keys of the imported Logix object

        node.name = config.name;
        node.host = config.host;
        node.readTag = config.readTag;
        node.writeTag = config.writeTag;
        node.dataType = config.dataType;
        node.writeValue = config.writeValue;

        let plc = null;
        let isConnected = false;
        let connecting = false;

        async function connectPLC() {
            if (connecting || isConnected) return Promise.resolve();
            connecting = true;
            node.status({ fill: 'yellow', shape: 'dot', text: 'connecting...' });

            return new Promise((resolve, reject) => {
                try {
                    // Check if Logix is an object and has a 'default' property that is a function
                    if (!Logix || typeof Logix.default !== 'function') { 
                        const errMsg = 'Failed to initialize PLC driver: node-logix.default is not a constructor/function. Type of Logix: ' + typeof Logix + (Logix ? ", Type of Logix.default: " + typeof Logix.default : "");
                        node.error(errMsg);
                        node.status({ fill: 'red', shape: 'ring', text: 'init error' });
                        connecting = false;
                        reject(new Error(errMsg));
                        return;
                    }

                    // plc = new Logix.default({ // Use Logix.default - OLD WAY
                    //     ipAddress: node.host,
                    //     port: port,
                    //     slot: 0, // Hardcoded to 0 for Micro800
                    //     Micro800: true,
                    //     connectTimeout: 5000 // Library's own connect timeout
                    // });

                    // NEW WAY: Using two arguments: host string and options object
                    plc = new Logix.default(node.host, {
                        port: port,
                        slot: 0, // Hardcoded to 0 for Micro800
                        Micro800: true,
                        connectTimeout: 500 // Library's own connect timeout
                    });
                    node.log(`Attempting to connect to ${node.host}:${port} slot 0 (Micro800: true) using new constructor form`);

                    plc.on('connect', () => {
                        isConnected = true;
                        connecting = false;
                        node.status({ fill: 'green', shape: 'dot', text: 'connected' });
                        node.log(`Connected to PLC at ${node.host}:${port} slot 0`);
                        resolve();
                    });

                    plc.on('connect_error', (err) => {
                        isConnected = false;
                        connecting = false;
                        const errorMessage = err.message || 'unknown error';
                        node.error('EVENT connect_error: ' + errorMessage);
                        node.status({ fill: 'red', shape: 'ring', text: 'conn error' });
                        if (plc && typeof plc.disconnect === 'function') {
                            plc.disconnect().catch(e => node.error('Error during cleanup disconnect: ' + e.message));
                        }
                        plc = null;
                        reject(new Error('EVENT connect_error: ' + errorMessage)); // Made error distinct
                    });

                    plc.on('disconnect', (reason) => {
                        isConnected = false;
                        connecting = false;
                        const eventReason = reason || 'unknown';
                        node.log(`EVENT disconnect: PLC disconnected, reason: ${eventReason}. isConnected set to false.`); // Added detailed log
                        node.status({ fill: 'red', shape: 'ring', text: 'disconnected' });
                        plc = null; // Ensure plc is nulled when a disconnect event occurs
                    });

                    // Initiate the connection
                    plc.connect().catch(connectInitiationError => {
                        // This catch is for immediate errors from calling plc.connect() itself,
                        // though most errors are expected via the 'connect_error' event.
                        connecting = false;
                        const errMsg = 'SYNC plc.connect() failed: ' + connectInitiationError.message; // Made error distinct
                        node.error(errMsg);
                        node.status({ fill: 'red', shape: 'ring', text: 'conn init fail' });
                        if (plc && typeof plc.disconnect === 'function') {
                            plc.disconnect().catch(e => node.error('Error during cleanup disconnect: ' + e.message));
                        }
                        plc = null; // Ensure plc is nulled if connect() call itself fails
                        reject(new Error(errMsg));
                    });

                } catch (initError) {
                    connecting = false;
                    const errMsg = 'Failed to initialize PLC driver (catch block): ' + initError.message;
                    node.error(errMsg);
                    node.status({ fill: 'red', shape: 'ring', text: 'init error' });
                    plc = null;
                    reject(new Error(errMsg));
                }
            });
        }

        async function disconnectPLC() {
            if (!plc) {
                node.log('No PLC instance to disconnect.');
                isConnected = false;
                connecting = false;
                node.status({});
                return;
            }
            try {
                if (typeof plc.disconnect === 'function') {
                    await plc.disconnect(); // Assuming disconnect might be async
                    node.log('PLC disconnect function called.');
                } else {
                    node.log('PLC object does not have a disconnect function.');
                }
            } catch (e) {
                node.error('Error during PLC disconnect: ' + e.message);
            }
            isConnected = false;
            connecting = false; // Ensure connecting flag is reset
            plc = null;
            node.status({}); // Clear status
        }

        // Initial connection attempt
        connectPLC().catch(err => {
            node.error("Initial PLC connection failed: " + err.message);
            // Status already set by connectPLC
        });

        node.on('input', async function(msg, send, done) {
            // Allow overrides from msg.payload
            const payload = msg.payload || {};
            let determinedAction = payload.action;

            if (!determinedAction) { // If no action in payload, determine from config
                if (node.readTag) { // Prioritize read if readTag is configured
                    determinedAction = 'read';
                } else if (node.writeTag && node.writeValue !== undefined && node.writeValue !== '') {
                    determinedAction = 'write';
                } else {
                    // Cannot determine a default action from configuration
                    node.error("No action specified in msg.payload, and node not configured for a default read or write operation.");
                    node.status({ fill: 'red', shape: 'ring', text: 'no default action' });
                    if(done) done("Cannot determine default action from config.");
                    return;
                }
            }

            const tag = payload.tag || (determinedAction === 'read' ? node.readTag : node.writeTag);
            const valueToWrite = payload.value !== undefined ? payload.value : node.writeValue;
            const configuredDataType = payload.dataType || node.dataType; // This is a string like 'SINT', 'DINT', etc.

            if (!tag) {
                node.status({ fill: 'red', shape: 'ring', text: 'no tag specified' });
                const errMsg = 'No tag specified for PLC operation';
                node.error(errMsg);
                if (done) done(errMsg); // Call done with error
                return;
            }

            if (!isConnected) {
                node.log('PLC not connected, attempting to connect before operation (input handler).');
                try {
                    await connectPLC();
                } catch (err) {
                    node.error(`Connection attempt failed in input handler. Error: ${err.message}`); // Refined log
                    if (done) done(`PLC connection failed: ${err.message}`);
                    return;
                }
                if (!isConnected) { // Check again after attempt
                     const errMsg = `PLC still not connected after attempt (isConnected is false, input handler). connectPLC promise resolved without error.`; // Refined log
                     node.error(errMsg);
                     node.status({ fill: 'red', shape: 'ring', text: 'conn failed' });
                     if (done) done(errMsg); // Call done with error
                     return;
                }
            }
            
            try {
                if (determinedAction === 'read') {
                    node.status({ fill: 'blue', shape: 'dot', text: `reading ${tag}` });
                    let resultTag;
                    try {
                        resultTag = await plc.read(tag, 1, configuredDataType);
                    } catch (readErr) {
                        node.warn('Read failed or returned error: ' + readErr.message);
                        resultTag = null;
                    }
                    node.log('Read resultTag: ' + JSON.stringify(resultTag)); // Debug log
                    msg.payload = {
                        tag: tag,
                        value: (resultTag && typeof resultTag === 'object' && resultTag !== null && 'value' in resultTag)
                            ? resultTag.value
                            : (resultTag === null ? null : resultTag),
                        dataType: node.dataType || 'unknown',
                        status: resultTag === null ? 'read-null' : 'read-success',
                    };
                    node.status({ fill: 'green', shape: 'dot', text: `read: ${tag}` });
                } else if (determinedAction === 'write') {
                    if (valueToWrite === undefined || valueToWrite === '') {
                        const errMsg = 'No value specified for PLC write operation';
                        node.error(errMsg);
                        node.status({ fill: 'red', shape: 'ring', text: 'no write value' });
                        if (done) done(errMsg);
                        return;
                    }
                    node.log(`Writing to tag: ${tag}, value: ${valueToWrite}, dataType: ${configuredDataType}`);
                    node.status({ fill: 'blue', shape: 'dot', text: `writing ${tag}` });
                    await plc.write(tag, valueToWrite, configuredDataType);
                    msg.payload = {
                        tag,
                        value: valueToWrite,
                        dataType: configuredDataType,
                        status: 'write-success',
                    };
                    node.status({ fill: 'green', shape: 'dot', text: `wrote: ${tag}` });
                } else {
                    throw new Error('Unknown action: ' + determinedAction);
                }
                send(msg);
                if (done) done();
            } catch (err) {
                const shortError = err.message.length > 30 ? err.message.substring(0, 27) + '...' : err.message;
                node.status({ fill: 'red', shape: 'ring', text: `Op err: ${shortError}` });
                node.error('PLC operation error: ' + err.message + (err.stack ? '\nStack: ' + err.stack : ''));
                if (done) done(err); // Call done with error
            }
        });

        node.on('close', async function(removed, doneCallback) {
            node.log('Node is closing, disconnecting PLC.');
            await disconnectPLC();
            node.log('PLC disconnected on close.');
            if (removed) {
                node.log('Node was removed.');
            }
            doneCallback();
        });
    }
    RED.nodes.registerType('Micro800', Micro800Node);
};
