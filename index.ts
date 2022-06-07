import { Plugin, PluginMeta, PluginEvent, RetryError } from '@posthog/plugin-scaffold'
import { PubSub, Topic } from "@google-cloud/pubsub"

type PubSubPlugin = Plugin<{
    global: {
        pubSubClient: PubSub
        pubSubTopic: Topic
    }
    config: {
        topicId: string
    },
}>

export const setupPlugin: PubSubPlugin['setupPlugin'] = async (meta) => {
    const { global, attachments, config } = meta

    const googleCloudKeyJson = process.env.GCP_KEY_JSON
    const _topicId = process.env.GCP_TOPIC_ID

    if (!googleCloudKeyJson) {
        throw new Error('JSON config not provided!')
    }
    if (!_topicId) {
        throw new Error('Topic ID not provided!')
    }

    let topicId = new Buffer(_topicId, 'base64');

    try {
        const credentials = JSON.parse(attachments.googleCloudKeyJson.contents.toString())
        global.pubSubClient = new PubSub({
            projectId: credentials['project_id'],
            credentials,
        })
        global.pubSubTopic = global.pubSubClient.topic(topicId);

        // topic exists
        await global.pubSubTopic.getMetadata()
    } catch (error) {
        // some other error? abort!
        if (!error.message.includes("NOT_FOUND")) {
            throw new Error(error)
        }
        console.log(`Creating PubSub Topic - ${topicId}`)

        try {
            await global.pubSubTopic.create()
        } catch (error) {
            // a different worker already created the table
            if (!error.message.includes('ALREADY_EXISTS')) {
                throw error
            }
        }
    }
}

export async function exportEvents(events: PluginEvent[], { global, config }: PluginMeta<PubSubPlugin>) {

    const topicId = process.env.GCP_TOPIC_ID
    if (!global.pubSubClient) {
        throw new Error('No PubSub client initialized!')
    }
    try {
        const messages = events.map((fullEvent) => {
            const { event, properties, $set, $set_once, distinct_id, team_id, site_url, now, sent_at, uuid, ...rest } =
                fullEvent
            const ip = properties?.['$ip'] || fullEvent.ip
            const timestamp = fullEvent.timestamp || properties?.timestamp || now || sent_at
            let ingestedProperties = properties
            let elements = []

            // only move prop to elements for the $autocapture action
            if (event === '$autocapture' && properties?.['$elements']) {
                const { $elements, ...props } = properties
                ingestedProperties = props
                elements = $elements
            }

            const message = {
                event,
                distinct_id,
                team_id,
                ip,
                site_url,
                timestamp,
                uuid: uuid!,
                properties: ingestedProperties || {},
                elements: elements || [],
                people_set: $set || {},
                people_set_once: $set_once || {},
            }
            return Buffer.from(JSON.stringify(message))
        })

        const start = Date.now()
        await Promise.all(
            messages.map((dataBuf) =>
                global.pubSubTopic.publish(dataBuf).then((messageId) => {
                    return messageId
                })
            )
        )
        const end = Date.now() - start

        console.log(
            `Published ${events.length} ${events.length > 1 ? 'events' : 'event'} to ${topicId}. Took ${
                end / 1000
            } seconds.`
        )
    } catch (error) {
        console.error(
            `Error publishing ${events.length} ${events.length > 1 ? 'events' : 'event'} to ${topicId}: `,
            error
        )
        throw new RetryError(`Error publishing to Pub/Sub! ${JSON.stringify(error.errors)}`)
    }
}