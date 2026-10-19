### Get formant values

## ⚠️ 本项目对上游（PraatSauce 1.0.8）的改动：
## 1. 读取分支（`.read <> 0`）里补了一行 `Copy: "x"`（见文件尾部 else 分支）。
##    上游那里 orgFormant 与 trackedFormant 指向同一对象，收尾 removeObject 删两次 → 脚本必崩。
##    这是本项目「已全量审核 → 不重算 F0/共振峰，直接读回对象」功能的前置条件。
## 2. 读取入口条件补 fileReadable 回落（同 get_pitch 补丁）：
##    formantRead 勾选而 .Formant 文件缺失时，回落到计算分支（.save 开着会顺手存盘，自愈），
##    否则 `Read from file` 直接报错中断整个批量脚本。
##    已验证：fileReadable 在 Praat 7.0.02 返回 1/0；文件存在时走读取分支，行为不变。

procedure fmt: .measureBandwidths, .timeStep, .maxN, .maxHz,
	... .windowLength, .preEmphFrom, .start, .end, .f1ref, .f2ref, .f3ref,
	... .save, .saveDir$, .read, .readDir$, .basefn$

## extract padded snippet.

snd = selected("Sound")

## the added 0.2 ms are due to some arcane rounding and solves a bug where
## otherwise there were too few measures in formants when using equidistant
## intervals. it does mean that formant measures can be skewed to one side
## by a few ms compared to other measures, which isn't perfect but probably
## not a major issue either.

@snippet: .start, .end, .windowLength + (.timeStep / 2) + 0.00018
snippet = selected("Sound")

## 本项目补丁：请求读但文件缺失 → 回落计算分支（与 get_pitch 同款）
if .read = 0 or fileReadable(.readDir$ + .basefn$ + ".Formant") = 0

  ## all formant calculation arguments are user-controlled

  orgFormant = noprogress To Formant (burg): .timeStep, .maxN, .maxHz,
    ... .windowLength, .preEmphFrom

  ## convert to formantGrid and back to remove undefineds

  #### Removed this for now because it messes up the time domain.
  #### Will add formant duplicates to any part of the sound file that isn't
  #### tracked because of the windowing

  ##

  ## use tracking algo to clean these up a bit.
  ## arguments are: how many formants to track, what are their references
  ## (F1-F5 have to be specified, but untracked formants are ignored),
  ## frequency cost, bandwidth cost, transition cost (the last three are all
  ## just defaults)

  ## Viterbi tracking has to be ignored if there are any frames where only
  ## 2 formants are tracked

  minFormants = Get minimum number of formants

  if minFormants < 3

    Copy: "x"
    trackedFormant = selected("Formant")

  else

    trackedFormant = noprogress Track: 3, .f1ref, .f2ref, .f3ref, 3500, 4500, 1,
      ... 1, 1

  endif

  if .save <> 0

    Save as text file: .saveDir$ + .basefn$ + ".Formant"

  endif

else

  Read from file: .readDir$ + .basefn$ + ".Formant"
  orgFormant = selected("Formant")
  ## 下面是本项目补的一行（PraatSauce 1.0.8 上游缺）。
  ## 原因：本分支原为 `trackedFormant = selected("Formant")`，与 orgFormant 指向同一对象，
  ##       而收尾 `removeObject: orgFormant, trackedFormant, table, snippet` 会删两次，
  ##       必然报 `Error: No object with number N.` 并中断整个脚本（formantRead 不可用）。
  ## 解法：与上面 `minFormants < 3` 分支同款 `Copy: "x"`，恢复「两个变量 = 两个对象」的不变式，
  ##       收尾无需改动。已验证：读对象路径与全量计算输出逐行一致，计算路径不受影响。
  Copy: "x"
  trackedFormant = selected("Formant")

endif

## grab frame times and number of frames

.times# = List all frame times
.numFrames = Get number of frames

## tabulate formants.
## these arguments concern whether frame number or times should be included
## (no, we already have them), whether intensity should be included (no, we
## calculate intensity separately because otherwise we don't get dB but some
## other unit), how many decimals to use, and whether to include bandwidths
## (depends if the user wants empirical bandwidths or wants to estimate them
## using the Hawks-Miller formula)

table = Down to Table: 0, 0, 3, 0, 3, 0, 3, .measureBandwidths

## ensure that there are no --undefined--s in f3 column

Formula (column range): "F3(Hz)", "F3(Hz)",
  ... "if self = undefined then " + string$(.f3ref) + " else self fi"

## grab formant values

.f1# = Get all numbers in column: "F1(Hz)"
.f2# = Get all numbers in column: "F2(Hz)"
.f3# = Get all numbers in column: "F3(Hz)"

## grab bandwidths if user wants empirical bandwidths

if .measureBandwidths <> 0
	.b1# = Get all numbers in column: "B1(Hz)"
	.b2# = Get all numbers in column: "B2(Hz)"
	.b3# = Get all numbers in column: "B3(Hz)"
endif

if .start > 0 | .end < dur

  @restrictInterval: .times#, .f1#, .start, .end
  .f1# = restrictInterval.newVals#
  @restrictInterval: .times#, .f2#, .start, .end
  .f2# = restrictInterval.newVals#
  @restrictInterval: .times#, .f3#, .start, .end
  .f3# = restrictInterval.newVals#
  .times# = restrictInterval.newTimes#

  if .measureBandwidths <> 0
    @restrictInterval: .times#, .b1#, .start, .end
    .b1# = restrictInterval.newVals#
    @restrictInterval: .times#, .b2#, .start, .end
    .b2# = restrictInterval.newVals#
    @restrictInterval: .times#, .b3#, .start, .end
    .b3# = restrictInterval.newVals#
  endif

  .numFrames = size(restrictInterval.newTimes#)

endif

## clean up

removeObject: orgFormant, trackedFormant, table, snippet
selectObject: snd

endproc
