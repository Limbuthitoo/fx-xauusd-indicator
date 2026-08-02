// Minimal MT5 bridge template for posting live candles to the local ORB app.
// Attach to an XAUUSD M5 chart. This does not place trades.
//
// In MT5, enable:
// Tools -> Options -> Expert Advisors -> Allow WebRequest for listed URL
// Add: http://localhost:7071

#property strict

input string ApiUrl = "http://localhost:7071/api/market-data/bridge/candles";
input string ApiSymbol = "XAUUSD";
input int TimeframeMinutes = 5;
input int PostEverySeconds = 5;
input bool PostFormingCandle = true;

int OnInit()
{
   EventSetTimer(MathMax(PostEverySeconds, 1));
   Print("ORB MT5 bridge started. Posting ", ApiSymbol, " M", TimeframeMinutes, " candles to ", ApiUrl);
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   int shift = PostFormingCandle ? 0 : 1;
   int copied = CopyRates(_Symbol, PERIOD_M5, shift, 1, rates);
   if(copied < 1)
   {
      Print("ORB bridge: no M5 candle copied for ", _Symbol, " error=", GetLastError());
      return;
   }

   MqlRates candle = rates[0];

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double spread = ask - bid;

   string timestamp = TimeToString(candle.time, TIME_DATE | TIME_SECONDS);
   StringReplace(timestamp, ".", "-");
   StringReplace(timestamp, " ", "T");
   timestamp = timestamp + "Z";

   string json = "{"
      + "\"symbol\":\"" + ApiSymbol + "\","
      + "\"timeframeMinutes\":" + IntegerToString(TimeframeMinutes) + ","
      + "\"source\":\"MT5_BRIDGE_LIVE\","
      + "\"autoEvaluate\":true,"
      + "\"candles\":[{"
      + "\"timestamp\":\"" + timestamp + "\","
      + "\"open\":" + DoubleToString(candle.open, _Digits) + ","
      + "\"high\":" + DoubleToString(candle.high, _Digits) + ","
      + "\"low\":" + DoubleToString(candle.low, _Digits) + ","
      + "\"close\":" + DoubleToString(candle.close, _Digits) + ","
      + "\"volume\":" + IntegerToString((int)candle.tick_volume) + ","
      + "\"spread\":" + DoubleToString(spread, _Digits)
      + "}]}";

   uchar payload[];
   StringToCharArray(json, payload, 0, StringLen(json), CP_UTF8);

   uchar result[];
   string resultHeaders;
   string headers = "Content-Type: application/json\r\n";
   ResetLastError();
   int status = WebRequest("POST", ApiUrl, headers, 5000, payload, result, resultHeaders);

   if(status == 200)
      Print("ORB bridge posted ", ApiSymbol, " candle ", timestamp, " close=", DoubleToString(candle.close, _Digits));
   else
      Print("ORB bridge post failed. status=", status, " error=", GetLastError());
}
