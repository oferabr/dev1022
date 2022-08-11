const eventTypes = require('./eventTypes');

const handleAzureReposWebhook = async (req, res) => {
    console.info('got webhook request:', req);
    const { body } = req;
    console.info(`body=\n${JSON.stringify(body)}`);
    const { subscriptionId, id, eventType, resource } = body;
    console.info(`eventType: ${eventType} id: ${id} subscriptionId: ${subscriptionId} resource: \n${JSON.stringify(resource)}`);
    if (eventTypes[eventType]) await eventTypes[eventType](body);

    return res.status(200).json({ success: true });
};

module.exports = { handleAzureReposWebhook };