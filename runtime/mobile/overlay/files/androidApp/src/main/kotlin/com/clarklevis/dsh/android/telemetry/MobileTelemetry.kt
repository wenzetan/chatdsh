package com.clarklevis.dsh.android.telemetry

import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 手机侧遥测。
 *
 * 手机不持有可观测平台的凭据，记录一律经控制平面的中转端点上报；控制平面补写形态与设备
 * 类别后再用自家 exporter 出网。记录名与属性键必须是 `docs/telemetry.md` 6.7 节与
 * `docs/mobile-protocol.md` 第三节登记过的那些，登记之外的键会被控制平面丢弃并计数。
 *
 * 采集默认开启，失败一律静默：遥测不能影响连接、发送与界面。本地队列有上限，满了丢最旧
 * 的记录；控制平面返回 404 表示遥测关闭，此后不再尝试上报。
 */
class MobileTelemetry(
    private val baseUrl: String,
    private val deviceToken: String,
    private val client: OkHttpClient = defaultClient(),
    private val clock: () -> Long = System::currentTimeMillis
) {
    /** 一条待上报记录。 */
    private data class Record(
        val signal: String,
        val name: String,
        val attributes: Map<String, Any>,
        val durationMs: Long?,
        val value: Double?
    )

    private val queue = ConcurrentLinkedQueue<Record>()
    private val reporting = AtomicBoolean(false)
    private val disabled = AtomicBoolean(false)

    /** 应用启动。`outcome` 取 `cold` 或 `warm`。 */
    fun startup(outcome: String) {
        enqueue(Record("span", "chatdsh.mobile.startup", mapOf("outcome" to outcome), null, null))
    }

    /** 一次连接尝试。`attempt` 从 1 开始，`outcome` 取 `ok`、`failed` 或 `timeout`。 */
    fun connect(attempt: Int, outcome: String, durationMs: Long) {
        enqueue(Record("span", "chatdsh.mobile.connect", mapOf("attempt" to attempt, "outcome" to outcome), durationMs, null))
        enqueue(Record("metric", "chatdsh_mobile_connect_seconds", emptyMap(), null, durationMs / 1000.0))
    }

    /** 本地通知投递。`kind` 取 `message`、`approval` 或 `question`，`outcome` 取 `shown` 或 `suppressed`。 */
    fun pushDeliver(kind: String, outcome: String) {
        enqueue(Record("span", "chatdsh.mobile.push.deliver", mapOf("kind" to kind, "outcome" to outcome), null, null))
    }

    /** 离线队列重放。`count` 是本次重放的记录数。 */
    fun queueReplay(count: Int, outcome: String) {
        enqueue(Record("event", "chatdsh.mobile.queue.replay", mapOf("count" to count, "outcome" to outcome), null, null))
    }

    /** 凭据读写。`action` 取 `read`、`write` 或 `delete`，`outcome` 取 `ok` 或 `failed`。 */
    fun keystore(action: String, outcome: String) {
        enqueue(Record("event", "chatdsh.mobile.keystore", mapOf("action" to action, "outcome" to outcome), null, null))
    }

    /** 当前离线队列深度。 */
    fun offlineQueueDepth(depth: Int) {
        enqueue(Record("metric", "chatdsh_mobile_offline_queue_depth", emptyMap(), null, depth.toDouble()))
    }

    /**
     * 把队列里的记录发出去。
     *
     * 并发调用时只有一次真正上报，其余直接返回；失败批次放回队列等下次再发。
     */
    fun flush() {
        if (disabled.get() || queue.isEmpty()) return
        if (!reporting.compareAndSet(false, true)) return
        var batch: List<Record> = emptyList()
        try {
            val collected = ArrayList<Record>(BATCH_LIMIT)
            while (collected.size < BATCH_LIMIT) collected.add(queue.poll() ?: break)
            batch = collected
            if (batch.isEmpty()) return
            send(batch)
        } catch (_: IOException) {
            // 网络问题留在队列里下次再发；不打印、不重试风暴。
            requeue(batch)
        } finally {
            reporting.set(false)
        }
    }

    /** 失败批次放回队尾。队尾有界，因此不会因持续失败撑爆内存。 */
    private fun requeue(batch: List<Record>) {
        for (record in batch) enqueue(record)
    }

    private fun send(batch: List<Record>) {
        val payload = buildJsonObject {
            put("records", buildJsonArray {
                for (record in batch) {
                    add(buildJsonObject {
                        put("signal", record.signal)
                        put("name", record.name)
                        put("time", clock())
                        record.durationMs?.let { put("durationMs", it) }
                        record.value?.let { put("value", it) }
                        put("attributes", buildJsonObject {
                            for ((key, value) in record.attributes) {
                                when (value) {
                                    is Int -> put(key, value)
                                    is Long -> put(key, value)
                                    is Double -> put(key, value)
                                    is Boolean -> put(key, value)
                                    else -> put(key, value.toString())
                                }
                            }
                        })
                    })
                }
            })
        }
        val request = Request.Builder()
            .url("$baseUrl/chatdsh/telemetry/mobile")
            .header(DEVICE_TOKEN_HEADER, deviceToken)
            .post(payload.toString().toRequestBody(JSON))
            .build()
        client.newCall(request).execute().use { response ->
            when (response.code) {
                // 遥测关闭：停止采集，后续调用直接返回。
                404 -> disabled.set(true)
                // 限流：本批丢弃，不放大重试。
                429 -> Unit
                else -> if (!response.isSuccessful) requeue(batch)
            }
        }
    }

    private fun enqueue(record: Record) {
        while (queue.size >= QUEUE_LIMIT) queue.poll()
        queue.offer(record)
    }

    companion object {
        /** 设备令牌请求头名。 */
        const val DEVICE_TOKEN_HEADER = "x-chatdsh-device-token"

        /** 单批最多条数，低于中转端点 64 条的上限。 */
        private const val BATCH_LIMIT = 32

        /** 本地队列上限；满了丢最旧的记录。 */
        private const val QUEUE_LIMIT = 256

        private val JSON = "application/json; charset=utf-8".toMediaType()

        private fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .callTimeout(15, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .build()
    }
}
