package com.clarklevis.dsh.android.platform

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * 控制平面的配对引导。
 *
 * 控制平面是手机的唯一入口：配对码在这里换成长期设备令牌，之后每次启动用令牌换运行时的
 * 带令牌路径。业务通道沿用上游的插件协议，因此这一层只处理引导，不参与会话状态。
 *
 * 令牌只在这个类里进出，不写入日志、异常消息与界面文案。
 */
class ControlPlanePairing(
    private val client: OkHttpClient = defaultClient()
) {
    /** 用户填写的控制平面地址与配对码。 */
    data class Credentials(
        val baseUrl: String,
        val pairingCode: String,
        val deviceName: String
    )

    /** 配对结果。`token` 只用于写入设备凭据存储。 */
    data class Paired(
        val token: String,
        val deviceId: String,
        val deviceName: String,
        val bootPath: String
    ) {
        override fun toString(): String =
            "Paired(deviceId=$deviceId, deviceName=$deviceName, token=<redacted>, bootPath=<redacted>)"
    }

    /** 控制平面拒绝请求。`code` 是响应体的 `error` 字段。 */
    class Failure(val status: Int, val code: String) : IOException("控制平面拒绝请求：$code（HTTP $status）") {
        /** 配对码或设备令牌无效，需要重新配对。 */
        val needsRepair: Boolean get() = status == 401

        /** 运行时尚未就绪，可以稍后重试。 */
        val retryable: Boolean get() = status == 503 || code == "runtime-not-ready"
    }

    /** 配对码换设备令牌。 */
    fun pair(credentials: Credentials): Paired {
        val origin = originOf(credentials.baseUrl)
        val payload = buildJsonObject {
            put("code", credentials.pairingCode.trim())
            put("deviceName", credentials.deviceName.trim())
            put("platform", "android")
        }
        val response = execute(
            Request.Builder()
                .url("$origin/chatdsh/gateway/mobile/pair")
                .post(payload.toString().toRequestBody(JSON))
                .build()
        )
        val body = decode(response)
        return Paired(
            token = required(body, "token"),
            deviceId = required(body, "deviceId"),
            deviceName = body["name"]?.jsonPrimitive?.contentOrNull?.takeIf(String::isNotBlank)
                ?: credentials.deviceName,
            bootPath = required(body, "bootPath")
        )
    }

    /** 用已保存的设备令牌换一次启动路径。令牌失效时抛 [Failure]。 */
    fun bootPath(baseUrl: String, token: String): String {
        val origin = originOf(baseUrl)
        val response = execute(
            Request.Builder()
                .url("$origin/chatdsh/gateway/mobile/session")
                .header(DEVICE_TOKEN_HEADER, token)
                .get()
                .build()
        )
        return required(decode(response), "bootPath")
    }

    /**
     * 业务通道地址：控制平面地址换成 WebSocket 协议，路径用插件的 `/ws/mobile`。
     *
     * 控制平面的反向代理按路径转发，插件在运行时就挂在这个路径上，因此手机不需要知道
     * 运行时的真实端口。
     */
    fun channelUrl(baseUrl: String): String {
        val origin = originOf(baseUrl)
        val scheme = if (origin.startsWith("https://")) "wss://" else "ws://"
        return "$scheme${origin.removePrefix("https://").removePrefix("http://")}$MOBILE_CHANNEL_PATH"
    }

    private fun execute(request: Request): Response {
        val response = client.newCall(request).execute()
        if (!response.isSuccessful) {
            val code = response.body?.string()?.let(::errorCodeOf) ?: "http-${response.code}"
            response.close()
            throw Failure(response.code, code)
        }
        return response
    }

    private fun decode(response: Response): Map<String, kotlinx.serialization.json.JsonElement> {
        val text = response.body?.string().orEmpty()
        response.close()
        require(text.isNotBlank()) { "控制平面返回了空响应" }
        return json.parseToJsonElement(text).jsonObject
    }

    private fun required(
        payload: Map<String, kotlinx.serialization.json.JsonElement>,
        key: String
    ): String {
        val value = payload[key]?.jsonPrimitive?.contentOrNull
        require(value != null && value.isNotBlank()) { "控制平面响应缺少 $key" }
        return value
    }

    /** 从错误响应里取 `error` 字段。 */
    private fun errorCodeOf(text: String): String? = runCatching {
        json.parseToJsonElement(text).jsonObject["error"]?.jsonPrimitive?.contentOrNull
    }.getOrNull()

    /**
     * 把用户填的地址规范成 `scheme://host[:port]`。
     *
     * 接受 `http`、`https`，也接受 `ws`、`wss`：部署时人更容易从业务通道地址里抄一份。
     * 路径、查询与片段一律丢掉，避免把 `/ws/mobile` 拼成 `/ws/mobile/ws/mobile`。
     */
    private fun originOf(raw: String): String {
        val trimmed = raw.trim()
        require(trimmed.isNotEmpty()) { "控制平面地址不能为空" }
        val withScheme = when {
            trimmed.startsWith("http://") || trimmed.startsWith("https://") -> trimmed
            trimmed.startsWith("ws://") -> "http://${trimmed.removePrefix("ws://")}"
            trimmed.startsWith("wss://") -> "https://${trimmed.removePrefix("wss://")}"
            else -> "http://$trimmed"
        }
        val url: HttpUrl = withScheme.toHttpUrl()
        require(url.scheme == "http" || url.scheme == "https") { "控制平面地址只支持 http 与 https" }
        require(url.username.isEmpty() && url.password.isEmpty()) { "控制平面地址不能包含凭据" }
        val port = if (url.port == defaultPort(url.scheme)) "" else ":${url.port}"
        return "${url.scheme}://${url.host}$port"
    }

    private fun defaultPort(scheme: String): Int = if (scheme == "https") 443 else 80

    companion object {
        /** 设备令牌的请求头名，与移动端协议文档一致。 */
        const val DEVICE_TOKEN_HEADER = "x-chatdsh-device-token"

        /** 插件的业务通道路径。 */
        const val MOBILE_CHANNEL_PATH = "/ws/mobile"

        private val JSON = "application/json; charset=utf-8".toMediaType()
        private val json = Json { ignoreUnknownKeys = true }

        private fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .callTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }
}
