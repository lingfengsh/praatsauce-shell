### ps_get_CPPS.praat — 标准 CPPS（Praat 官方算法，Maryn & Weenink 2015）
##
## 命名规范：本项目新写的 Praat 脚本一律加 ps_ 前缀，与上游 PraatSauce 脚本
## 区分，便于升级上游时保留本地脚本、只对照重打补丁。
##
## 算法（与 cpp 过程的差别只在取峰之前先对倒谱做二维平滑）：
##   Sound → PowerCepstrogram → Smooth(时间 0.01s, 倒频 0.001s) → 逐帧取峰。
##   - 平滑窗 0.01s/0.001s = Maryn & Weenink (2015, J Voice) 推荐值；
##     Hillenbrand & Houde (1996) 原文为 0.02s/0.001s（见 Praat 手册 Smooth 页 Note）。
##   - 减趋势（Subtract trend before smoothing）= no（M&W 2015 推荐设置）。
##   - 趋势线 = Straight、拟合 = Robust（M&W 2015 协议；非 cpp 过程的
##     exponential decay / robust slow）。
## 输出为逐帧轨迹：Smooth 后跑 To Table (cepstral peak prominences)，
## 与 CPP 列同构，可直接进汇总长表。注意 To Table 的列名固定为 "CPP(dB)"
## （无论倒谱是否平滑过），读列名时不要想当然改成 CPPS(dB)。
##
## 依赖：@snippet（extract_snippet.praat）、@restrictInterval（restrictInterval.praat），
## 由 praatSauce.praat 统一 include。

procedure cpps: .timeStep, .f0min, .f0max, .start, .end

snd = selected("Sound")

## extract padded snippet（与 cpp 过程同款，保证帧对齐口径一致）

@snippet: .start, .end, ((6 * (1 / .f0min)) / 2) + (.timeStep / 2)
snippet = selected("Sound")

snippetDur = Get total duration
if snippetDur < (1 / .f0min) * 6
  .f0min = ((1 / snippetDur) * 6) + 1
endif

## create cepstrogram, then smooth it (time domain first, then quefrency domain)

cep = noprogress To PowerCepstrogram: .f0min, .timeStep, 5000, 50
Smooth: 0.01, 0.001
.times# = List all frame times

## tabulate per-frame CPPS values on the smoothed cepstrogram
## 取峰参数与 cpp 过程同款（tolerance 0.05、parabolic、quefrency range 1/f0max–1/f0min），
## 仅趋势/拟合改为 Maryn & Weenink (2015) 的 Straight/Robust

table = To Table (cepstral peak prominences): 0, 0, 6, 3, 0, 3, .f0min, .f0max,
  ... 0.05, "parabolic", 0.001, 0, "Straight", "Robust"
.res# = Get all numbers in column: "CPP(dB)"

## grab number of rows

.numFrames = Get number of rows

if .start > 0 | .end < dur

  @restrictInterval: .times#, .res#, .start, .end

  .times# = restrictInterval.newTimes#
  .res# = restrictInterval.newVals#
  .numFrames = size(restrictInterval.newTimes#)

endif

## clean up

removeObject: cep, table, snippet
selectObject: snd

endproc
