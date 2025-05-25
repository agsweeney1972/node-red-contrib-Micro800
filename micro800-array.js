// Micro800 PLC Array Node for Node-RED
const Logix = require('node-logix');

module.exports = function(RED) {
    function Micro800ArrayNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.host = config.host;
        node.arrayTag = config.arrayTag;
        node.dataType = config.dataType;
        node.length = parseInt(config.length, 10);
        if (isNaN(node.length) || node.length < 1) {
            node.length = 1; // fallback default
        }
        node.action = config.action;
        node.writeValue = config.writeValue;

        let plc = null;
        let isConnected = false;
        let connecting = false;

        async function connectPLC() {
            if (connecting || isConnected) return Promise.resolve();
            connecting = true;
            return new Promise((resolve, reject) => {
                try {
                    plc = new Logix.default(node.host, {
                        Micro800: true,
                        connectTimeout: 500
                    });
                    plc.on('connect', () => {
                        isConnected = true;
                        connecting = false;
                        node.status({ fill: 'green', shape: 'dot', text: 'connected' });
                        resolve();
                    });
                    plc.on('connect_error', (err) => {
                        isConnected = false;
                        connecting = false;
                        node.status({ fill: 'red', shape: 'ring', text: 'conn error' });
                        plc = null;
                        reject(new Error('EVENT connect_error: ' + (err.message || 'unknown error')));
                    });
                    plc.connect().catch(connectInitiationError => {
                        connecting = false;
                        node.status({ fill: 'red', shape: 'ring', text: 'conn init fail' });
                        plc = null;
                        reject(new Error('SYNC plc.connect() failed: ' + connectInitiationError.message));
                    });
                } catch (initError) {
                    connecting = false;
                    node.status({ fill: 'red', shape: 'ring', text: 'init error' });
                    plc = null;
                    reject(new Error('Failed to initialize PLC driver: ' + initError.message));
                }
            });
        }

        node.on('input', async function(msg, send, done) {
            const action = msg.payload && msg.payload.action ? msg.payload.action : node.action;
            // Always extract the base tag (remove any [index] if present)
            let tag = msg.payload && msg.payload.arrayTag ? msg.payload.arrayTag : node.arrayTag;
            tag = tag.replace(/\[.*\]$/, ''); // Remove [index] if user entered it
            // Always parse config as int, only override if valid and >0
            let length = parseInt(node.length, 10);
            if (isNaN(length) || length < 1) {
                length = 1; // fallback default
            }
            if (
                msg.payload &&
                typeof msg.payload.length !== 'undefined' &&
                !isNaN(parseInt(msg.payload.length, 10)) &&
                parseInt(msg.payload.length, 10) > 0
            ) {
                length = parseInt(msg.payload.length, 10);
            }
            const dataType = msg.payload && msg.payload.dataType ? msg.payload.dataType : node.dataType;
            // If the tag is a string type, force dataType to STRING
            // This allows users to read arrays of STRING tags
            if (dataType && typeof dataType === 'string' && dataType.trim().toUpperCase() === 'STRING') {
                node.log('Detected STRING dataType for array operation.');
            }
            let valueToWrite = msg.payload && msg.payload.writeValue !== undefined ? msg.payload.writeValue : node.writeValue;

            node.log(`DEBUG: tag=${tag}, length=${length}`);

            if (!tag || !length || !dataType) {
                node.status({ fill: 'red', shape: 'ring', text: 'missing config' });
                if (done) done('Missing tag, length, or dataType');
                return;
            }

            if (!isConnected) {
                try {
                    await connectPLC();
                } catch (err) {
                    node.error('PLC connection failed: ' + err.message);
                    node.status({ fill: 'red', shape: 'ring', text: 'conn failed' });
                    if (done) done('PLC connection failed: ' + err.message);
                    return;
                }
            }

            try {
                if (action === 'read') {
                    node.log(`Attempting to read array: tag=${tag}, length=${length}`);
                    node.status({ fill: 'blue', shape: 'dot', text: `reading ${tag}[0..${length-1}]` });
                    let values = [];
                    for (let i = 0; i < length; i++) {
                        try {
                            node.log(`Reading element: ${tag}[${i}] with dataType: ${dataType}`);
                            const singleResult = await plc.read(`${tag}[${i}]`, 1, dataType);
                            node.log(`Result for ${tag}[${i}]: ${JSON.stringify(singleResult)}`);
                            let val = singleResult && (singleResult.value !== undefined ? singleResult.value : singleResult);
                            values.push(val);
                        } catch (e) {
                            node.error(`Failed to read ${tag}[${i}]: ${e.message}`);
                            values.push(null);
                        }
                    }
                    msg.payload = {
                        tag: tag, // Use base tag, not tag[0]
                        value: values,
                        dataType: dataType,
                        status: 'read-success'
                    };
                    node.status({ fill: 'green', shape: 'dot', text: `read: ${tag}[${length}]` });
                } else if (action === 'write') {
                    if (typeof valueToWrite === 'string') {
                        try {
                            valueToWrite = JSON.parse(valueToWrite);
                        } catch (e) {
                            node.status({ fill: 'red', shape: 'ring', text: 'invalid writeValue' });
                            if (done) done('writeValue must be a JSON array');
                            return;
                        }
                    }
                    if (!Array.isArray(valueToWrite) || valueToWrite.length !== length) {
                        node.status({ fill: 'red', shape: 'ring', text: 'array length mismatch' });
                        if (done) done('writeValue must be an array of length ' + length);
                        return;
                    }
                    node.status({ fill: 'blue', shape: 'dot', text: `writing ${tag}[0..${length-1}]` });
                    await plc.write(`${tag}[0]`, valueToWrite, dataType);
                    msg.payload = {
                        tag: tag,
                        value: valueToWrite,
                        dataType: dataType,
                        status: 'write-success'
                    };
                    node.status({ fill: 'green', shape: 'dot', text: `wrote: ${tag}[${length}]` });
                } else {
                    throw new Error('Unknown action: ' + action);
                }
                send(msg);
                if (done) done();
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: 'Op err' });
                node.error('PLC operation error: ' + err.message);
                if (done) done(err);
            }
        });

        node.on('close', async function(removed, doneCallback) {
            if (plc && typeof plc.disconnect === 'function') {
                await plc.disconnect();
            }
            plc = null;
            isConnected = false;
            connecting = false;
            doneCallback();
        });
    }
    RED.nodes.registerType('Micro800-Array', Micro800ArrayNode);
};
