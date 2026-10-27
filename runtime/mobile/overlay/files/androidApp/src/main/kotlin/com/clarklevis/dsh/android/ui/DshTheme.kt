package com.clarklevis.dsh.android.ui

import android.app.Activity
import android.content.res.Configuration
import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SwitchColors
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat

/**
 * 配色令牌的唯一来源。
 *
 * 取值逐项对应 `runtime/docs/ui-baseline-design.md` 第二节的颜色令牌：暗色为默认，
 * `Light*` 那组是同一语义的亮色映射。界面代码只引用这里的名字，不写颜色字面值；
 * 换配色时改这一个对象，页面不必逐个文件改。
 */
internal object DshColors {
    /** 应用画布底色（`--chatdsh-bg`）。 */
    val Canvas = Color(0xFF0E0E10)

    /** 一级面板与卡片容器（`--chatdsh-panel`）。 */
    val Panel = Color(0xFF17181C)

    /** 二级面板与侧栏底板（`--chatdsh-panel-2`）。 */
    val PanelRaised = Color(0xFF1B1D22)

    /** 代码块与终端背景（`--chatdsh-code-bg`）。 */
    val Code = Color(0xFF121317)

    /** 弱结构分割线（`--chatdsh-line`）。 */
    val Line = Color(0xFF24262C)

    /** 控件边框与强分隔（`--chatdsh-line-2`）。 */
    val LineStrong = Color(0xFF30333B)

    /** 标题与高亮正文（`--chatdsh-ink`）。 */
    val InkPrimary = Color(0xFFF3F5F9)

    /** 常规正文（`--chatdsh-ink-2`）。 */
    val Ink = Color(0xFFC7CCD6)

    /** 辅助说明（`--chatdsh-muted`）。 */
    val Muted = Color(0xFF9AA1AD)

    /** 未激活与极弱提示（`--chatdsh-faint`）。 */
    val Faint = Color(0xFF858D9A)

    /** 品牌标记与图标高亮（`--chatdsh-brand`）。 */
    val Brand = Color(0xFF4D6BFE)

    /** 主按钮填充（`--chatdsh-brand-fill`）。 */
    val BrandFill = Color(0xFF3D56E8)

    /** 主按钮按下（`--chatdsh-brand-fill-down`）。 */
    val BrandFillDown = Color(0xFF3549C9)

    /** 用户消息气泡（`--chatdsh-bubble`）。 */
    val Bubble = Color(0xFF2E3F9E)

    /** 用户消息气泡文字（`--chatdsh-bubble-ink`）。 */
    val BubbleInk = Color(0xFFE6EAFF)

    /** 成功与在线（`--chatdsh-ok`）。 */
    val Success = Color(0xFF3FB37F)

    /** 警告与等待授权（`--chatdsh-warn`）。 */
    val Warning = Color(0xFFE8B04B)

    /** 错误与危险动作（`--chatdsh-danger`）。 */
    val Danger = Color(0xFFFF7B7B)

    /** 品牌实色上的文字与图形。 */
    val OnBrand = Color(0xFFFFFFFF)

    /** 画布底色，供动画背景与状态栏衔接使用。 */
    val Navy = Canvas

    /** 一级面板，供动画背景的分层过渡使用。 */
    val NavyRaised = Panel

    /** 主行动点与当前选中项。 */
    val Ocean = Brand

    /** 弱高亮文字。 */
    val Mist = Color(0xFF6B84FF)

    /** 浅色主题的画布底色。 */
    val Paper = Color(0xFFF6F7F9)

    /** 助手与思考轨迹的标记色。 */
    val Purple = Color(0xFF6B84FF)

    /** 工具与子工具轨迹的标记色。 */
    val Orange = Warning

    /** 等待授权的标记色。 */
    val Amber = Warning

    /** 亮色主题下的语义取值。 */
    object Light {
        val Canvas = Color(0xFFF6F7F9)
        val Panel = Color(0xFFFFFFFF)
        val PanelRaised = Color(0xFFF1F3F7)
        val Code = Color(0xFFF4F5F8)
        val Line = Color(0xFFE4E7ED)
        val LineStrong = Color(0xFFD3D8E1)
        val InkPrimary = Color(0xFF12141A)
        val Ink = Color(0xFF3A404B)
        val Muted = Color(0xFF676D79)
        val Faint = Color(0xFF7D8491)
        val Brand = Color(0xFF3D56E8)
        val BrandFill = Color(0xFF3D56E8)
        val BrandFillDown = Color(0xFF3549C9)
        val Bubble = Color(0xFF3D56E8)
        val BubbleInk = Color(0xFFFFFFFF)
        val Success = Color(0xFF1F9D63)
        val Warning = Color(0xFFB4790A)
        val Danger = Color(0xFFD64545)
    }
}

@Composable
internal fun StatusIndicatorDot(
    color: Color,
    modifier: Modifier = Modifier,
    glowing: Boolean = false
) {
    val decoratedModifier = if (glowing) {
        modifier.dropShadow(
            shape = CircleShape,
            shadow = Shadow(
                radius = 5.dp,
                spread = 1.dp,
                color = color.copy(alpha = 0.28f),
                offset = DpOffset(0.dp, 0.dp)
            )
        )
    } else {
        modifier
    }
    Box(decoratedModifier.background(color, CircleShape))
}

private val LightColors = lightColorScheme(
    primary = DshColors.BrandFill,
    secondary = DshColors.Purple,
    background = DshColors.Light.Canvas,
    surface = DshColors.Light.Panel,
    surfaceVariant = DshColors.Light.PanelRaised,
    outline = DshColors.Light.LineStrong,
    error = DshColors.Light.Danger,
    onPrimary = DshColors.OnBrand,
    onBackground = DshColors.Light.InkPrimary,
    onSurface = DshColors.Light.InkPrimary
)

private val DarkColors = darkColorScheme(
    primary = DshColors.Brand,
    secondary = DshColors.Purple,
    background = DshColors.Canvas,
    surface = DshColors.Panel,
    surfaceVariant = DshColors.PanelRaised,
    outline = DshColors.LineStrong,
    error = DshColors.Danger,
    onPrimary = DshColors.OnBrand,
    onBackground = DshColors.InkPrimary,
    onSurface = DshColors.InkPrimary
)

@Composable
internal fun DshTheme(
    appearance: AppearanceSettings = rememberAppearanceSettings(),
    content: @Composable () -> Unit
) {
    val view = LocalView.current
    val systemDensity = LocalDensity.current
    val fontScale = appearance.effectiveFontScale
    val appDensity = remember(systemDensity, fontScale) { AppFontDensity(systemDensity, fontScale) }
    val dark = appearance.interfaceStyle.isDark(isSystemInDarkTheme())
    val configuration = Configuration(LocalConfiguration.current).apply {
        uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
            if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
    }
    SideEffect {
        val window = (view.context as? Activity)?.window ?: return@SideEffect
        window.statusBarColor = Color.Transparent.toArgb()
        window.navigationBarColor = Color.Transparent.toArgb()
        WindowCompat.getInsetsController(window, view).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.isNavigationBarContrastEnforced = false
            }
        }
    }
    // 所有页面的深浅色判断使用同一份有效配置，避免只更新 MaterialTheme 而留下浅色背景。
    CompositionLocalProvider(
        LocalAppearanceSettings provides appearance,
        LocalDensity provides appDensity,
        LocalConfiguration provides configuration
    ) {
        MaterialTheme(colorScheme = if (dark) DarkColors else LightColors) {
            CompositionLocalProvider(LocalRippleConfiguration provides null) { DshMenuHost(content) }
        }
    }
}

// 保留 Android 的系统字号转换（包括非线性缩放），再应用用户选择的倍率。
internal class AppFontDensity(
    private val systemDensity: Density,
    private val appScale: Float
) : Density {
    override val density: Float = systemDensity.density
    override val fontScale: Float = systemDensity.fontScale * appScale

    override fun TextUnit.toDp(): Dp = systemDensity.toDp(this) * appScale

    override fun androidx.compose.ui.unit.Dp.toSp(): TextUnit =
        systemDensity.toSp(this / appScale)

    /** 用系统密度把文本尺寸换成 dp；显式传参，避免接收者标签与扩展函数重名。 */
    private fun Density.toDp(value: TextUnit): Dp = with(this) { value.toDp() }

    /** 用系统密度把 dp 换成文本尺寸。 */
    private fun Density.toSp(value: Dp): TextUnit = with(this) { value.toSp() }
}

@Composable
internal fun dshSwitchColors(preserveDisabledColors: Boolean = false): SwitchColors {
    val fill = if (isSystemInDarkTheme()) DshColors.BrandFill else DshColors.Light.BrandFill
    if (!preserveDisabledColors) return SwitchDefaults.colors(
        checkedTrackColor = fill,
        checkedBorderColor = fill,
        checkedThumbColor = DshColors.OnBrand
    )
    val uncheckedTrack = MaterialTheme.colorScheme.surfaceContainerHighest
    val uncheckedBorder = MaterialTheme.colorScheme.outline
    val uncheckedThumb = MaterialTheme.colorScheme.outline
    return SwitchDefaults.colors(
        checkedTrackColor = fill,
        checkedBorderColor = fill,
        checkedThumbColor = DshColors.OnBrand,
        uncheckedTrackColor = uncheckedTrack,
        uncheckedBorderColor = uncheckedBorder,
        uncheckedThumbColor = uncheckedThumb,
        disabledCheckedTrackColor = fill,
        disabledCheckedBorderColor = fill,
        disabledCheckedThumbColor = DshColors.OnBrand,
        disabledUncheckedTrackColor = uncheckedTrack,
        disabledUncheckedBorderColor = uncheckedBorder,
        disabledUncheckedThumbColor = uncheckedThumb
    )
}
