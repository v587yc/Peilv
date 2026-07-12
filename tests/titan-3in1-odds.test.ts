import { describe, expect, it } from "vitest";
import { parseThreeInOneLatestOdds } from "@/lib/titan-3in1-odds";

const html = `
<div class="hg">
  <table class="gts">
    <tbody>
      <tr class="gta"><td>时</td><td>比分</td><td>主</td><td>盘</td><td>客</td><td>变化</td><td>状</td></tr>
      <tr class="gt1"><td></td><td>-</td><td style="color:green;">1.03</td><td>一球</td><td style="color:red;">0.86</td><td>07-11<br>00:30</td><td class="hg_red">即</td></tr>
      <tr class="gt2"><td></td><td>-</td><td>1.04</td><td>一球</td><td>0.85</td><td>07-11<br>00:30</td><td class="hg_red">即</td></tr>
    </tbody>
  </table>
  <table class="gts">
    <tbody>
      <tr class="gta"><td>时</td><td>比分</td><td>大</td><td>盘</td><td>小</td><td>变化</td><td>状</td></tr>
      <tr class="gt1"><td></td><td>-</td><td>0.99</td><td>2.5/3</td><td>0.89</td><td>07-10<br>23:58</td><td class="hg_red">即</td></tr>
      <tr class="gt2"><td></td><td>-</td><td>1.00</td><td>2.5/3</td><td>0.88</td><td>07-10<br>23:49</td><td class="hg_red">即</td></tr>
    </tbody>
  </table>
  <table class="gts">
    <tbody>
      <tr class="gta"><td>时</td><td>比分</td><td>主</td><td>和</td><td>客</td><td>变化</td><td>状</td></tr>
      <tr class="gt1"><td></td><td>-</td><td>1.60</td><td>3.95</td><td>6.00</td><td>07-10<br>19:54</td><td class="hg_red">即</td></tr>
    </tbody>
  </table>
</div>
`;

describe("parseThreeInOneLatestOdds", () => {
  it("reads the first full-time rows from handicap, total, and euro tables", () => {
    expect(parseThreeInOneLatestOdds(html)).toEqual({
      handicapHome: "1.03",
      handicapLine: "一球",
      handicapAway: "0.86",
      totalOver: "0.99",
      totalLine: "2.5/3",
      totalUnder: "0.89",
      euroHome: "1.60",
      euroDraw: "3.95",
      euroAway: "6.00",
      handicapObservedAt: "07-11 00:30",
      totalObservedAt: "07-10 23:58",
      euroObservedAt: "07-10 19:54",
    });
  });
});
